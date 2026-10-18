# Các bước kiểm soát Gemini

Ứng dụng kiểm soát từng bước theo thứ tự:

**Tải video → Kiểm tra tệp → Nhận dạng → Kiểm tra lời nói và mốc thời gian → Dịch → Kiểm tra các đoạn dịch → Xuất MP4/SRT.**

- Quy tắc dịch trong `prompts/gemini-subtitles.md` được gửi cho Gemini. JSON schema yêu cầu đầu ra có đúng ID và nội dung từng đoạn.
- Bộ kiểm tra trên máy giữ đủ lời thoại, kiểm tra mốc thời gian trong phạm vi video, xử lý mốc 0/chồng nhau bằng các khoảng thời gian thật và từ chối dữ liệu không hợp lệ.
- Nếu phản hồi nhận dạng không qua kiểm tra, ứng dụng yêu cầu nhận dạng lại **tối đa một lần**, dùng lại tệp đã tải lên. Không thử lại theo cách này khi không có lời nói, key sai hoặc hết hạn mức. Một lần nhận dạng bổ sung có sử dụng hạn mức Gemini.
- Nhận dạng và các đợt dịch đã hoàn tất được lưu lại; thử lại công việc tiếp tục từ phần chưa xong. Từng đoạn dịch vẫn phải qua kiểm tra, không tự bỏ câu hoặc dùng dữ liệu sai để xuất video.
- Nếu tiếp tục lỗi, thông báo phân biệt sai mốc, nội dung không khớp, phản hồi chưa xong, thiếu/trùng đoạn dịch hoặc JSON sai. Lịch sử lưu lý do, số lần gọi và số token nhà cung cấp thực sự trả về, không lưu phản hồi thô hoặc API key.

Quy trình này do chương trình thực thi. File hướng dẫn giúp cách dịch nhất quán; kiểm tra dữ liệu và số lần thử được ràng buộc bằng mã. Các lỗi tải YouTube, mạng và hạn mức vẫn được báo riêng.
