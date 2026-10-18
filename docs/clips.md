# Cắt video thành nhiều đoạn

Trong trang video, mở **Cắt video thành nhiều đoạn**, chọn nguồn và nhập điểm bắt đầu/kết thúc cho từng đoạn. Có thể dùng **Lấy vị trí đang xem** ở mỗi mốc hoặc **Xem từ điểm bắt đầu** để kiểm tra trong trình phát. **Thêm đoạn** tạo thêm một khoảng, **Xóa** bỏ khoảng chưa cần. Nhấn **Xuất các đoạn MP4**, chờ công việc hoàn tất rồi tải từng tệp từ **Các đoạn đã xuất**. Chỉ thao tác xuất này mới bắt đầu cắt; thay đổi mốc không tự tạo tệp.

Nguồn được chọn ban đầu theo thứ tự: MP4 lồng tiếng đúng phiên bản đã lưu, MP4 có phụ đề đúng phiên bản đã lưu, rồi video gốc. MP4 giữ nội dung hình ảnh, phụ đề đã ghép và âm thanh của tệp đã xuất. Video gốc không được thêm phụ đề hoặc giọng lồng tiếng của ứng dụng. Khi nguồn đang chọn trở nên cũ sau khi cập nhật phụ đề/phân vai, bảng giữ nguyên các mốc và yêu cầu chọn nguồn hợp lệ; không tự chuyển sang tệp khác. Cần lưu hoặc bỏ các thay đổi phụ đề/phân vai trước khi xuất.

- Chấp nhận số giây (`12.375`), `MM:SS[.mmm]` (`01:02.005`) hoặc `HH:MM:SS[.mmm]` (`01:02:03.250`). Trong dạng có dấu hai chấm, giây phải có hai chữ số từ `00` đến `59`; phút trong dạng có giờ cũng từ `00` đến `59`. Phút trong dạng `MM:SS` có thể lớn hơn 59.
- Mỗi yêu cầu gồm 1–20 đoạn; mỗi đoạn ít nhất 0,25 giây và kết thúc không quá thời lượng video. Tổng các đoạn tối đa 1.500 giây (25 phút). Có thể chọn các khoảng chồng nhau, và thứ tự tải giữ theo thứ tự các khoảng.
- Yêu cầu đang chờ hoặc đang chạy sẽ chặn lần xuất tiếp theo. Có thể hủy bằng nút hủy công việc hiện có trên trang video. Chức năng này cắt các tệp có sẵn; không gọi dịch vụ AI và không tự xuất lại phụ đề/lồng tiếng.
- Danh sách tải là bộ đoạn xuất thành công gần nhất; bộ mới thay thế bộ trước khi hoàn tất thành công. Mốc thời gian, nguồn và phiên bản của bộ đã xuất được hiển thị riêng với bản lựa chọn đang sửa. Bộ cũ vẫn được ghi rõ khi nội dung đã lưu thay đổi. Tệp hết hạn không còn tải được.

`ClipPanel({ job, currentTime, onSeek, onChanged, busy, dirty })` dùng dữ liệu job do trang cha thăm dò; gắn `key={job.id}` khi chuyển video. `onSeek({ start })` tua trình phát xem trước, còn `onChanged()` tải lại job sau khi máy chủ nhận yêu cầu. `busy` khóa xuất khi trang cha đang xử lý; `dirty` gồm các sửa đổi phụ đề và phân vai chưa lưu.

Gửi `POST /api/jobs/:id/clips` với `{ source, subtitleVersion, dubbingVersion, ranges: [{ start, end }] }`, trong đó mốc là số giây và `source` là `video`, `dubbed` hoặc `source`. Máy chủ trả `202 { job }`. Kết quả công khai là `job.clipsOutput = { token, source, subtitleVersion, dubbingVersion, clips: [{ index, start, end, duration }] }`; `index` bắt đầu từ 0. Tải MP4 tại `GET /api/jobs/:id/clips/:token/:index`; từng thành phần đường dẫn được mã hóa riêng.

Kiểm tra quy tắc nhập mốc, giới hạn, chọn nguồn và trạng thái phiên bản bằng `node --test tests/clips-client.test.mjs` trong thư mục `web`.
