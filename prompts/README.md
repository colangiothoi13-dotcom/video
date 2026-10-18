# Chỉnh quy tắc dịch Gemini

Sửa `gemini-subtitles.md` để điều chỉnh cách Gemini dịch phụ đề, chẳng hạn giọng văn, cách xưng hô hoặc thuật ngữ. Lưu file bằng UTF-8, giữ nội dung không rỗng và tối đa 16 KiB. Nội dung file được gửi đến Gemini, nên không đưa API key hoặc thông tin bí mật vào đây.

Ứng dụng đọc lại file trước mỗi lượt dịch Gemini; thay đổi áp dụng cho lượt gọi tiếp theo mà không cần khởi động lại. Lượt đang gửi đến Gemini giữ quy tắc đã đọc. File này không điều khiển phiên âm, OpenAI hoặc tạo video.

Giữ các ràng buộc về ngôn ngữ đích từ `language`, ID, số lượng đoạn và JSON đầu ra. Ứng dụng vẫn thêm chỉ dẫn cố định để bảo vệ cấu trúc dữ liệu và xử lý lời thoại như nội dung cần dịch. Nếu file thiếu, trống, sai UTF-8 hoặc quá lớn, lượt dịch dừng với lỗi `AI_RULES_INVALID` trước khi gửi yêu cầu dịch.

Kiểm tra bộ đọc bằng `node --test tests/subtitle-rules.test.mjs` từ thư mục `web`. Các kiểm thử dùng file tạm và không gọi dịch vụ AI.
