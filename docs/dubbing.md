# Lồng tiếng nhiều nhân vật

Mở video đã có phụ đề, chọn **Phân vai và lồng tiếng** ở đầu trang để chuyển đến mục **Lồng tiếng**.

1. Video mới dùng Gemini nhận diện người nói ngay trong lần nhận dạng phụ đề đầu tiên và tự gán vai sau khi dịch xong, không cần gọi nhận dạng lần thứ hai. Với video cũ chưa có phân vai, chọn **Phân vai tự động** để Gemini gợi ý người nói, hoặc tự gán câu cho các vai có sẵn. Khi đã có cấu hình, nút **Nhận diện lại người nói** cho phép chủ động chạy lại bước nhận dạng.
2. Sửa tên vai, chọn giọng và kiểm tra các câu đánh dấu chưa chắc. Có thể thêm tối đa 8 vai. Chọn thời gian câu để xem đoạn video tương ứng.
3. **Lưu phân vai và giọng**, rồi **Nghe thử một câu** của từng vai. Mỗi lần nghe thử dùng câu đầu tiên được gán cho vai đó.
4. Chọn **Xuất MP4 lồng tiếng**. Có thể rời màn hình rồi quay lại lịch sử. Khi hoàn tất, tải bản lồng tiếng ở mục này; MP4 phụ đề cũ vẫn được giữ riêng.

Âm gốc giảm khi có giọng Việt và trở lại trong khoảng trống. Cách này giảm cả lời gốc, nhạc và hiệu ứng, không tách riêng giọng gốc. Các giọng là giọng có sẵn do bạn chọn cho nhân vật.

Phân vai tự động là gợi ý. Trường hợp nhiều người nói hoặc nói chồng nhau có thể cần sửa. Nếu câu dịch quá dài cho thời gian đã có, ứng dụng báo rút gọn câu; không tự cắt mất lời. Giọng chỉ được tăng tốc tối đa hai lần.

Sửa phụ đề hoặc đổi phân vai làm bản lồng tiếng trước đó thành bản cũ. Lưu lại và xuất bản mới để áp dụng. Ứng dụng giữ các câu đã tạo trong bộ nhớ đệm trên máy để tiếp tục khi thử lại; đổi nội dung hoặc giọng sẽ tạo âm thanh mới.

Cần API key Google trong Cài đặt. Tạo giọng dùng mô hình Gemini TTS và hạn mức riêng. Phân vai tự động của video mới dùng kết quả nhận dạng ban đầu; nút **Phân vai tự động** hoặc **Nhận diện lại người nói** gọi lại nhận dạng tiếng nói và dùng hạn mức Gemini. Thao tác lưu/gán vai không gọi AI. Các tệp kết quả theo thời hạn hiển thị trên trang video.

Tài liệu nhà cung cấp: [Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation), [nhận diện người nói](https://ai.google.dev/gemini-api/docs/transcribe#speaker-diarization).
