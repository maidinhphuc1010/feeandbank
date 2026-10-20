# Lab 3 — Kế hoạch triển khai

> Trạng thái: đã triển khai Fee Service và Bank Service dựa trên yêu cầu trong trao đổi. File đề Lab 3 chưa có trong workspace tại `C:\Users\DELL\Desktop\LAB3`, nên chưa thể đối chiếu chính xác contract và tiêu chí nghiệm thu của đề.

## 7 giai đoạn

- [ ] **1. Đọc và phân tích đề** — xác nhận yêu cầu, đầu vào/đầu ra, ràng buộc và tiêu chí nghiệm thu từ toàn bộ file đề.
- [ ] **2. Chốt kiến trúc** — xác định trách nhiệm hai service, giao tiếp, dữ liệu và các quyết định kỹ thuật theo đề.
- [x] **3. Khởi tạo dự án** — Node.js + Express, cấu hình ENV, scripts PowerShell và bộ khung hai service (cơ sở hạ tầng; chưa phải nghiệp vụ).
- [x] **4. Thiết kế API và dữ liệu** — hợp đồng tạm cho Fee/Bank, in-memory, idempotency và giới hạn charge.
- [x] **5. Triển khai nghiệp vụ** — quản lý dư nợ/thanh toán và xử lý charge/stats.
- [x] **6. Kiểm thử và tích hợp** — kiểm thử API cơ bản bằng Node test runner.
- [ ] **7. Hoàn thiện, tài liệu và nghiệm thu** — đã có hướng dẫn; còn đối chiếu hợp đồng và tiêu chí nghiệm thu với file đề gốc.

## Kiểm chứng tình huống

- [x] Tình huống 1: Bank tắt trả 503 nhanh, GET công nợ hoạt động, Bank bật lại thanh toán 201 không restart Fee.
- [x] Tình huống 2: DELAY_MS=5000, timeout trả 504 + PENDING, giữ công nợ; timer không chặn event loop.
- [x] 20 thanh toán đồng thời: tối đa 1128,8ms; GET công nợ trong lúc chờ tối đa 5,8ms (lần chạy kiểm thử cục bộ).
- [x] Gọi lại payment sau timeout sử dụng khóa cũ: PAID, không charge hai lần.
- Kiểm tra cú pháp đạt; 5/5 test đạt. Timeout ở tình huống 1 được cập nhật từ 503 sang 504; lỗi kết nối vẫn 503.

- [x] Tình huống 3: HTTP/HTTPS Keep-Alive pool; 200/200 thanh toán 1000đ với concurrency=10, TCP mới=10; sau idle 6014,9ms trả 201, tổng TCP=11. Script: `npm run test:scenario3`. Kiểm thử hồi quy 5/5 đạt.

- [x] Tình huống 4: retry ≤4 lần, cùng khóa, deadline 1000ms; DROP 60/60 (390,5ms max), FAIL 59/60 (389ms max); không charge trùng, công nợ được kiểm tra từng sinh viên. 25 triệu: 402 đúng 1 lần gọi; lỗi 100%: 504/PENDING. 8/8 test đạt; tình huống 3 vẫn 200/200, 10 TCP, sau idle 201.

## Tổng kiểm thử tự động

- [x] `npm run verify`: kiểm tra cú pháp, 8/8 regression test, 6/6 nhóm audit PASS (bao phủ 4 tình huống).
- [x] Báo cáo thực đo: `reports/REPORT.md`; dữ liệu JSON: `reports/latest.json`.
- [x] Đo HTTP, thời gian, TCP Fee → Bank, attempts, charges, duplicates, công nợ; đối chiếu từng tiêu chí.
- [x] Sửa PATCH ép PAID không qua Bank; cô lập ENV cho benchmark; sửa mô tả BANK_FAIL_NEXT.
- [x] README có lệnh tái lập, phạm vi phép đo, giới hạn dữ liệu và giải thích baseline N/A.
- [ ] Baseline trước tối ưu chưa có snapshot để đo A/B; không thay thế bằng số liệu bịa. Nghiệm thu đề gốc vẫn chờ file đề.

## Bộ khung hiện tại

- Service 1: cổng `4001` (`SERVICE1_PORT`), health check `GET /health`.
- Service 2: cổng `4002` (`SERVICE2_PORT`), health check `GET /health`.
- `GET /health` chỉ là endpoint kiểm tra hoạt động, không chứa nghiệp vụ Lab 3.
