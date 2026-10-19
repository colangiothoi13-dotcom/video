# Video từ giọng gốc

Đây là mục mới bên cạnh các chức năng hiện có của VietSub Studio. Dán liên kết YouTube/Facebook để lấy âm thanh gốc và tạo phần hình ảnh mới có chuyển động theo nội dung lời đọc.

## Cách dùng

1. Mở **Video từ giọng gốc** trên thanh bên.
2. Dán link video công khai từ YouTube hoặc Facebook. Chọn khung dọc 9:16 hoặc ngang 16:9.
3. Bấm **Tạo video từ giọng gốc**. Ứng dụng tải nguồn, nhận dạng lời đọc, chia cảnh, tạo từng clip rồi ghép MP4. Quá trình và trạng thái từng cảnh hiển thị từ công việc thật.
4. Xem từng cảnh hoặc video hoàn chỉnh, rồi tải MP4.
5. Nếu cần thay hình một cảnh, sửa và lưu mô tả riêng của cảnh, sau đó chủ động tạo lại. Các cảnh khác và giọng đọc giữ nguyên. Khi đủ các clip hiện hành, bấm ghép lại để cập nhật MP4.

Mục mới có danh sách dự án riêng. Đóng tab rồi mở lại có thể xem tiến trình/kết quả đã lưu; giữ ứng dụng và máy hoạt động trong lúc xử lý. Bản nháp chưa lưu cần được lưu trước khi rời màn hình. Tạo dự án mới không xóa dự án cũ.

## Giữ giọng đọc và thời gian

MP4 kết quả dùng track âm thanh chính lấy từ video nguồn, bao gồm nhạc nền và hiệu ứng vốn có trong track đó. Giữ thứ tự lời đọc, cao độ, tốc độ và vị trí trên timeline. Bản đầu không tách riêng giọng khỏi nhạc và không tạo giọng mới.

Ứng dụng tạo bản MP3 nén riêng để AI nhận dạng; bản này chỉ dùng cho phân tích và giữ cùng mốc thời gian với nguồn. Với Gemini, nhận dạng lời nói và lập kế hoạch cảnh dùng chính mô hình đã chọn trong Cài đặt; không tự chuyển sang mô hình phiên âm riêng. Mốc lời nói do mô hình trả về được kiểm tra trước khi chia cảnh. Âm thanh từ các clip AI không được đưa vào bản MP4 cuối. Bản ghép mã hóa âm thanh nguồn thành AAC 192 kbps để tương thích MP4 và giữ thời gian mà không sửa lời đọc. Âm thanh bắt đầu trễ, bắt đầu trước khung hình đầu hoặc kết thúc sớm vẫn được đặt đúng trên timeline nguồn.

Hình mới hướng tới cảnh quay đời thực, chuyển động tự nhiên, 720p. Số cảnh thay đổi theo thời lượng nguồn; các cảnh được cắt/ghép đúng khoảng thời gian, gồm cả khoảng lặng. Mô hình có thể tạo hình chưa đúng ý hoặc chưa nhất quán hoàn toàn; xem preview rồi sửa/tạo lại cảnh đó. Đây là cảnh minh họa theo lời đọc, không tự tái tạo chính xác người xuất hiện trong video nguồn.

## Cài đặt và giới hạn

Cần công cụ tải nguồn và FFmpeg/FFprobe hiện có của ứng dụng. Web tự đọc thời lượng và xử lý toàn bộ video nguồn đã kết thúc, không giới hạn 25 phút; nguồn tối đa 5 GB và có giọng nói. Nhận các dạng link YouTube/Facebook được bộ nhập hiện tại hỗ trợ. Video riêng tư, livestream đang diễn ra hoặc nội dung yêu cầu đăng nhập có thể không tải được. Nhận dạng âm thanh dài được chia thành các phần tối đa 20 phút khi vượt 30 phút, sau đó đưa mốc lời đọc về đúng timeline nguồn; mỗi nhóm lập kế hoạch vẫn tối đa 20 cảnh. Tổng số cảnh theo đủ thời lượng nguồn, mỗi clip tạo bởi Veo vẫn dài 4, 6 hoặc 8 giây trước khi ghép.

Nhận dạng và viết mô tả cảnh dùng nhà cung cấp AI đã chọn trong **Cài đặt**. Tạo clip dùng khóa Google có quyền Veo. Sử dụng AI cần Internet và hạn mức phù hợp; số cảnh tăng theo thời lượng nguồn nên có thể phát sinh nhiều yêu cầu tạo clip. Mở màn hình và xem preview không tự tạo nội dung có phí.

Nếu một bước/cảnh lỗi, đọc thông báo tại dự án/cảnh rồi chủ động tiếp tục hoặc tạo lại. Clip đã thành công được giữ. Nếu ứng dụng bị ngắt lúc gửi yêu cầu tạo nhưng chưa lưu được mã tác vụ, không tự gửi lại để tránh tạo trùng; kiểm tra tài khoản dịch vụ trước khi thử lại.

Dự án, nguồn âm thanh/video và lịch sử của mục này giữ trên máy đến khi bạn xóa dự án. Dùng nút xóa riêng khi không có công việc đang chạy. Các công việc phụ đề, lồng tiếng, cắt clip và Video từ ý tưởng vẫn dùng dữ liệu và luồng hiện có.

## Xác minh

Kiểm thử tự động dùng nguồn/nhận dạng/AI fixture cục bộ và FFmpeg thật để kiểm tra timeline, track âm thanh gốc, preview, lịch sử và tạo lại cảnh độc lập. Việc kiểm tra nội dung hình ảnh do AI thật sinh ra cần chạy với nguồn và tài khoản có quyền phù hợp; kết quả fixture không đại diện chất lượng hình ảnh của dịch vụ thật.
