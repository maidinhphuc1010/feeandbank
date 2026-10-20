# Lab 3 — Báo cáo kiểm thử thực tế

UTC: 2026-10-20T03:45:46.875Z; Node v22.12.0; win32.

HTTP loopback, hai server cùng tiến trình, dữ liệu mới mỗi tình huống. TCP đếm tại Bank trước request giám sát; không gồm client → Fee. Duplicates tính theo paymentId; debt là tổng công nợ. TH3 gồm 200 payment và 1 payment sau idle.

| Tình huống | HTTP | Max ms | TCP | Attempts | Charges | Duplicates | Bank amount | Debt | Kết quả |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1: Bank down/up | {"201":1,"503":1} | 19.5 | 1 | 1 | 1 | 0 | 1000 | 0 | PASS |
| 2: delay 5000, concurrency 20 | {"504":20} | 1064.22 | 20 | 20 | 20 | 0 | 20000 | 20000 | PASS |
| 3: batch 200 + idle payment | {"201":201} | 89.6 | 11 | 201 | 201 | 0 | 201000 | 0 | PASS |
| 4: DROP=0.3 | {"201":60} | 181.42 | 18 | 77 | 60 | 0 | 60000 | 0 | PASS |
| 4: FAIL=0.3 | {"201":60} | 177.18 | 1 | 75 | 60 | 0 | 60000 | 0 | PASS |
| 4: 25 million | {"402":1} | 3.34 | 1 | 1 | 0 | 0 | 0 | 25000000 | PASS |

## 1: Bank down/up
- **PASS**: 503 under 1500ms
- **PASS**: GET alive, debt unchanged
- **PASS**: 201 without Fee restart
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## 2: delay 5000, concurrency 20
- **PASS**: 504 PENDING <=4500ms
- **PASS**: concurrent GET max 18.52ms <300
- **PASS**: all debt unchanged
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## 3: batch 200 + idle payment
- **PASS**: 200/200 HTTP 201
- **PASS**: batch TCP 10 <=20
- **PASS**: idle 6000ms then 201
- **PASS**: all debts zero
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## 4: DROP=0.3
- **PASS**: >=54/60 HTTP 201
- **PASS**: <=4500ms
- **PASS**: unknown = 504 PENDING
- **PASS**: exact student debts
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## 4: FAIL=0.3
- **PASS**: >=54/60 HTTP 201
- **PASS**: <=4500ms
- **PASS**: unknown = 504 PENDING
- **PASS**: exact student debts
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## 4: 25 million
- **PASS**: 402, one attempt
- **PASS**: debt unchanged
- **PASS**: <=4500ms
- **PASS**: no duplicate charge
- **PASS**: Bank totals consistent

## Trước/sau tối ưu

Baseline trước tối ưu: **N/A**. Không có snapshot mã nguồn hoặc số liệu đủ kiểm chứng để chạy A/B. Không bịa số liệu trước tối ưu. Các mốc lịch sử sau đây đều đã tối ưu, không dùng để suy ra tăng tốc:

| Mốc | Số liệu lịch sử |
|---|---|
| TH1 | Bank tắt 14,8ms; timeout 1026,5ms |
| TH2 | 20 payment max 1128,8ms; GET max 5,8ms |
| TH3 | 200/200; TCP 10; sau idle 6014,9ms HTTP 201 |
| TH4 | DROP 60/60 max 402,8ms; FAIL 60/60 max 170,7ms |

Số liệu hiện tại ở bảng đầu báo cáo. Tải máy và lỗi ngẫu nhiên thay đổi giữa các lần đo; không bảo đảm tuyệt đối ≥54/60.

## Sửa lỗi rà soát

- Cô lập DROP_RATE/FAIL_RATE trong script scenario3 khỏi ENV bên ngoài.
- Chặn PATCH ép trạng thái FAILED sang PAID không có Bank xác nhận; không ghi đè transactionId đã xác nhận.
- Sửa mô tả BANK_FAIL_NEXT: cờ tĩnh, không phải one-off.

Chạy `npm run verify`: regression và audit. Dữ liệu in-memory mất khi restart. Chưa có file đề gốc để nghiệm thu ngoài các tiêu chí người dùng đã cung cấp.
