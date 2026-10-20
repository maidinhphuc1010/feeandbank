# Lab 3 — Node.js + Express

Dự án gồm Fee Service và Bank Service độc lập, lưu dữ liệu trong bộ nhớ. Xem [`PLAN.md`](./PLAN.md) để theo dõi 7 giai đoạn. **File đề Lab 3 chưa có trong workspace**, nên các chi tiết API dưới đây bám theo yêu cầu trong trao đổi; cần đối chiếu/cập nhật nếu đề quy định hợp đồng khác.

## Swagger / OpenAPI

Chạy `npm start`, sau đó mở:

- Fee Swagger UI: http://localhost:4001/api-docs/
- Bank Swagger UI: http://localhost:4002/api-docs/
- OpenAPI JSON: http://localhost:4001/openapi.json và http://localhost:4002/openapi.json

Mỗi service có tài liệu riêng, mô tả request/response, status code và header Idempotency-Key. `Try it out` gọi đúng service đang mở (kể cả khi đổi cổng ENV). Thử Fee theo thứ tự: PUT công nợ cho `s1` với amount 1000 → POST /payments với studentId `s1` → GET công nợ. Bank phải đang chạy và BANK_URL trỏ đúng địa chỉ.

**Lưu ý:** Try it out thay đổi dữ liệu thật trong bộ nhớ. Gọi Bank /charges trực tiếp không tự cập nhật công nợ Fee. UI/assets được phục vụ từ dependency cục bộ, không cần CDN. Test tài liệu: `node --test test/swagger.test.js`.

## Yêu cầu

- Node.js 20 trở lên
- npm

## Cài đặt (PowerShell)

```powershell
Copy-Item .env.example .env
npm install
```

Có thể sửa `SERVICE1_PORT` và `SERVICE2_PORT` trong `.env`; mặc định lần lượt là `4001` và `4002`.


## Fee Service API (`http://localhost:4001`)

- `PUT /students/:studentId/debt` với `{ "amount": 120000 }`: tạo/cập nhật công nợ (số nguyên không âm).
- `GET /students/:studentId/debt`: xem công nợ.
- `POST /payments` với `{ "studentId": "s1" }`: tạo thanh toán cho toàn bộ dư nợ, trạng thái `PENDING`, ID tuần tự `P1`, `P2`, …
- `GET /payments`, `GET /payments/:paymentId`: liệt kê/xem thanh toán.
- `PATCH /payments/:paymentId/status` với `{ "status": "PAID", "transactionId": "..." }`: cập nhật trạng thái (`PENDING`, `PAID`, `FAILED`). Chuyển sang `PAID` khấu trừ dư nợ.

## Bank Service API (`http://localhost:4002`)

- `POST /charges`, bắt buộc header `Idempotency-Key`; body `{ "paymentId": "P1", "studentId": "s1", "amount": 120000 }`. Trả `201` và charge khi thành công; khóa lặp cùng payload trả cùng kết quả, dùng lại khóa với payload khác trả `409`.
- Tổng amount thành công tối đa `20,000,000`; vượt mức trả `402`, không retry.
- `GET /charges`: liệt kê charge; `GET /stats`: số charge, tổng tiền, hạn mức và phần còn lại.
- ENV lỗi: `BANK_FAIL=true` mô phỏng Bank unavailable cho mọi charge; `BANK_FAIL_NEXT=true` mô phỏng lỗi charge. Đây là cờ ENV tĩnh khi khởi động, không tự tắt sau một lần gọi.

Mọi dữ liệu và khóa idempotency chỉ tồn tại trong bộ nhớ, sẽ mất khi tiến trình khởi động lại. `POST /payments` tự gọi Bank qua `BANK_URL` (mặc định `http://127.0.0.1:4002`) với timeout 1000ms, thành công trả `201`, trạng thái `PAID` và trừ công nợ. Khi Bank tắt hoặc lỗi mạng, Fee trả `503`. Khi hết thời gian chờ, Fee trả `504` với `payment.status = PENDING`; cả hai trường hợp đều giữ nguyên công nợ. Timeout không chứng minh giao dịch thất bại ở Bank. Gọi lại cùng student sau khi Bank bật lại sử dụng cùng payment ID/Idempotency-Key; không cần restart Fee. Retry tối đa 4 lần gọi với cùng khóa, backoff 50/100/200ms trong tổng deadline 1000ms; chỉ retry lỗi truyền tải và HTTP 5xx. Timeout hoặc hết lượt retry trả 504/PENDING; ECONNREFUSED trả ngay 503. HTTP 4xx không retry. Các route API và trạng thái là hợp đồng tạm theo yêu cầu trong trao đổi vì chưa có file đề để đối chiếu.

## Tình huống 2: Bank phản hồi chậm

Trong terminal Bank, đặt `$env:DELAY_MS = '5000'` rồi chạy `npm run start:bank`.
Fee vẫn chạy bằng `npm run start:fee` ở terminal khác.

- `DELAY_MS` trì hoãn phản hồi thành công mới bằng timer bất đồng bộ, không chặn event loop.
- Bank lưu charge và khóa idempotency trước khi trì hoãn. Fee hủy chờ sau 1000ms, trả `504` + `payment.status: PENDING`, không đánh dấu `FAILED` hoặc trừ công nợ.
- Client gọi lại `POST /payments` cho cùng sinh viên để đối chiếu kết quả bằng khóa cũ. Bank trả kết quả đã lưu ngay, không delay replay và không charge thêm; Fee chuyển `PAID` và trừ công nợ một lần.
- Không cho sửa công nợ hay ép trạng thái bằng PATCH trong lúc giao dịch còn chờ đối chiếu (`409`).
- Test dùng 20 sinh viên khác nhau để có 20 giao dịch thực sự đồng thời; nhiều request cùng sinh viên đang xử lý bị từ chối `409`.
- Dữ liệu/idempotency chỉ trong bộ nhớ: bảo đảm chống charge lặp không tồn tại qua restart Bank.

## Tình huống 3: Keep-Alive và connection pooling

Fee dùng HTTP/HTTPS Agent tích hợp Node.js: `keepAlive=true`, `maxSockets=20`, `maxTotalSockets=20`, `maxFreeSockets=10`, scheduling LIFO, socket idle timeout 4000ms. Timeout toàn bộ charge vẫn là 1000ms (bao gồm chờ pool và đọc body). Response được đọc hết trước khi tái sử dụng socket. Socket idle được loại bỏ; request sau 6 giây mở kết nối mới nếu cần, không cần restart service.

Chạy `npm run test:scenario3`. Script tự khởi động hai HTTP server trên cổng ngẫu nhiên với dữ liệu mới, DELAY_MS=0 và tắt giả lập lỗi; không dùng hay sửa dữ liệu service đang chạy. Script gửi 200 thanh toán, concurrency=10, mỗi thanh toán 1000đ. Số TCP được đếm trực tiếp bằng sự kiện `connection` ở Bank, chỉ gồm đường Fee → Bank, không gồm client → Fee. Request đọc stats được thực hiện sau khi chốt số kết nối để tránh làm sai phép đo.

Kết quả thực đo trên Node v22.12.0:

| Chỉ số | Kết quả |
| --- | --- |
| Thành công | 200/200, HTTP 201 + PAID |
| Tổng tiền batch | 200.000đ |
| Thời gian batch | 557,2ms |
| p95 / tối đa | 46,8ms / 58,2ms |
| TCP mới trong batch | 10 (yêu cầu ≤20) |
| Idle thực tế | 6014,9ms |
| Thanh toán sau idle | HTTP 201, 7,7ms |
| TCP mới sau idle | 1 |
| TCP tổng gồm thanh toán sau idle | 11 |
| Tổng charge / tiền sau idle | 201 / 201.000đ |

Đây là phép đo HTTP loopback cục bộ, hai server trong một tiến trình; số liệu thời gian thay đổi theo tải máy. Script có assertion và exit code khác 0 nếu tiêu chí không đạt. Sau phép đo, script đóng server và pool.

## Tình huống 4: retry và kết quả giao dịch chưa rõ

- Bank đọc `DROP_RATE` và `FAIL_RATE` từ ENV khi khởi động, giá trị từ 0 đến 1.
- DROP: ngắt TCP sau khi lưu charge; có thể tiếp tục drop phản hồi replay. FAIL: trả 503 trước khi tạo charge. Lỗi tạm thời không được lưu như kết quả cuối cùng.
- Cùng payment luôn dùng cùng Idempotency-Key và payload. Bank replay kết quả đã lưu, không tăng tổng tiền. Fee chỉ trừ công nợ khi xác nhận SUCCESS; PENDING giữ nguyên công nợ để đối chiếu lại.
- Chạy riêng: `node --test test/scenario4.test.js`.
- Lần đo thực tế: DROP_RATE=0.3 đạt 60/60, 79 lần gọi, 60 charge, tối đa 390,5ms; FAIL_RATE=0.3 đạt 59/60, 83 lần gọi, 59 charge, tối đa 389ms. Giao dịch còn lại trả 504/PENDING và giữ nguyên nợ.
- Test lỗi 100% xác nhận tối đa 4 lần gọi, trả 504/PENDING; 25 triệu trả 402/FAILED với đúng 1 lần gọi và công nợ giữ nguyên.
- Tỷ lệ ngẫu nhiên không bảo đảm tuyệt đối ≥54/60 trong mọi lần chạy. Với lỗi độc lập 30%, xác suất thành công sau tối đa 4 lần là 99,19% nếu không hết deadline; test có assertion ngưỡng ≥54/60.

## Kiểm thử toàn bộ và báo cáo tự động

Chạy từ thư mục dự án trên PowerShell:

```powershell
npm run verify
```

Lệnh chạy kiểm tra cú pháp, 8 regression test và audit đủ 4 tình huống. Audit tự tạo server trên cổng ngẫu nhiên, dữ liệu riêng, không cần bật service trước; xuất `reports/REPORT.md` và `reports/latest.json`. Mỗi tiêu chí có PASS/FAIL; exit code khác 0 nếu test hoặc audit thất bại. Chạy riêng audit bằng `npm run audit`. Các file báo cáo được ghi đè mỗi lần chạy.

Số liệu audit mới nhất: TH1 503/201, max 19,5ms; TH2 20/20 trả 504/PENDING, max 1064,22ms, GET max 18,52ms; TH3 200/200 + idle payment thành công, batch 10 TCP (11 gồm idle); DROP và FAIL đều 60/60; 25 triệu 402 trong 3,34ms, đúng một lần gọi. Duplicates bằng 0 ở mọi tình huống. Xem báo cáo để biết charges và tổng công nợ.

Baseline trước tối ưu không còn mã nguồn/số liệu đủ kiểm chứng, nên báo cáo ghi N/A thay vì tạo số liệu giả. Các số lịch sử trong README là các lần chạy đã tối ưu, không phải benchmark A/B. Ngưỡng được đối chiếu theo yêu cầu trong hội thoại, chưa phải xác nhận toàn bộ đề gốc.

PATCH không được ép payment sang PAID; chỉ POST /payments với xác nhận từ Bank mới được trừ công nợ. PATCH cùng trạng thái trả dữ liệu hiện tại và không sửa transactionId đã xác nhận.

## Kiểm thử

```powershell
npm test
npm run check
```

## Chạy

Chạy đồng thời cả hai service trong một tiến trình:

```powershell
npm start
```

Hoặc chạy từng service trong hai cửa sổ PowerShell riêng:

```powershell
npm run start:service1
npm run start:service2
```

Chạy chế độ tự khởi động lại khi sửa mã (mỗi lệnh trong một cửa sổ riêng):

```powershell
npm run dev:service1
npm run dev:service2
```

Kiểm tra tại `http://localhost:4001/health` và `http://localhost:4002/health`.
