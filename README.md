# VietSub Studio

Ứng dụng dịch phụ đề video chạy trên máy Windows của bạn: nhập video qua tệp hoặc đường dẫn công khai, nhận dạng lời nói, dịch, biên tập và xuất MP4 cùng SRT UTF-8. Âm thanh gốc được giữ lại. Giao diện không dùng video mẫu hoặc tiến độ mô phỏng.

## Cài đặt lần đầu

Cần Node.js 24.21 trở lên, npm và kết nối Internet để tải phụ thuộc, công cụ và gọi dịch vụ AI. Mở PowerShell trong thư mục `web`:

```powershell
npm install
npm run setup
npm run build
npm start
```

Mở địa chỉ local mà cửa sổ khởi động hiển thị, mặc định [http://127.0.0.1:3000](http://127.0.0.1:3000). Ứng dụng chỉ nghe trên máy này. Không mở cổng ra Internet hoặc triển khai bản này công khai.

`npm run setup` tải yt-dlp chính thức và kiểm tra SHA-256, FFmpeg/FFprobe, libass và phông chữ. yt-dlp chỉ cần cho nhập đường dẫn; tải video từ máy có thể dùng khi FFmpeg, FFprobe và AI đã sẵn sàng.

Sau lần cài đầu, nhấp đúp **Khoi-dong.cmd**. Launcher cài phụ thuộc nếu chưa có, tạo bản dựng nếu cần rồi chạy production. Nếu sửa mã nguồn, chạy `npm run build` để cập nhật bản production.

## Khóa API và mô hình

Trong **Cài đặt**, nhập khóa OpenAI API của bạn và bấm **Lưu cài đặt**, sau đó **Kiểm tra kết nối**. Kiểm tra này xác nhận quyền truy cập; cần chạy video có lời nói để kiểm tra đầy đủ quy trình. Khóa không được hiển thị lại, không lưu trong localStorage và không đưa vào Git. Để trống ô thay khóa khi muốn giữ nguyên khóa hiện tại.

Mặc định dịch bằng `gpt-5.6-terra`; có thể thay bằng tên mô hình mà tài khoản của bạn được cấp quyền. Nhận dạng dùng `whisper-1`. Chi phí dịch vụ AI tính theo tài khoản của bạn. Nếu cấu hình qua biến môi trường `OPENAI_API_KEY` hoặc `OPENAI_TRANSLATION_MODEL`, biến môi trường được ưu tiên hơn cài đặt trên đĩa.

## Dịch, sửa và tải video

1. Trong **Tạo video**, dán đường dẫn công khai hoặc chọn/kéo tệp video vào vùng tải lên. Chọn ngôn ngữ đích và kiểu phụ đề. Hình phong cảnh chỉ minh họa kiểu chữ.
2. Bấm **Dịch và tạo phụ đề**. Tiến độ hiển thị trạng thái thực tế từ bộ xử lý; mỗi lần xử lý một công việc, các video khác xếp hàng. Có thể mở lại trong **Lịch sử video**.
3. Khi có phụ đề, nhấn mốc thời gian của đoạn để tua video. Sửa bản dịch rồi bấm **Lưu phụ đề**. Nội dung chưa lưu được giữ khi mất kết nối; không đóng trình duyệt nếu còn bản sửa cần giữ.
4. Tải **SRT** sau khi lưu. Bấm **Xuất lại** để ghép phiên bản đã lưu vào MP4. MP4 bản cũ vẫn được phân biệt rõ trong lúc chưa có bản mới. Bấm **Tải MP4** khi xuất xong.

Nếu phiên khác sửa cùng phụ đề, ứng dụng giữ bản đang soạn và báo xung đột. Sao chép nội dung cần giữ rồi dùng **Nạp bản máy chủ** để đồng bộ. Các nút lưu/xuất lại không tự ghi đè phiên bản mới hơn.

Giới hạn: tối đa 25 phút và 500 MB mỗi video. Kết quả MP4 H.264/AAC tối đa 720p theo hướng nguồn, giữ tỉ lệ, không phóng lớn video nhỏ. SRT dùng UTF-8, tối đa hai dòng mỗi đoạn; câu dịch dài được cảnh báo để rút gọn. Nguồn không có âm thanh/lời nói, tệp lỗi và nội dung riêng tư/DRM có thể không xử lý được.

## Chạy nền và tắt máy

Giữ cửa sổ launcher/terminal mở đến khi công việc hoàn thành. Thu nhỏ cửa sổ để tiếp tục làm việc; đóng tab trình duyệt không dừng máy chủ. Đóng cửa sổ máy chủ, nhấn Ctrl+C hoặc tắt/ngủ máy sẽ ngắt việc xử lý. Mở lại launcher để bộ xử lý kiểm tra checkpoint và khôi phục công việc hợp lệ. Không mở nhiều bản ứng dụng để tăng tốc; chỉ một video chạy mỗi lần.

## Dữ liệu và thời hạn

Dữ liệu ứng dụng, cấu hình máy chủ, cơ sở dữ liệu và các tệp công việc nằm trong `.data` bên trong thư mục `web`; công cụ tải về nằm trong `.tools`. Hai thư mục đều được loại khỏi Git. Khóa API ở cấu hình máy chủ là bí mật; hạn chế quyền truy cập máy/thư mục này. Bản gốc mà bạn tải lên từ máy không bị thay đổi.

Kết quả được giữ 24 giờ kể từ **lần xuất thành công đầu tiên**, xuất lại không gia hạn. Công việc lỗi/hủy được giữ 24 giờ từ trạng thái đó. Phiên tải lên dở được dọn sau một giờ không hoạt động. Dọn dẹp chạy mỗi 15 phút và bảo vệ tệp đang xử lý. Hãy tải MP4/SRT cần giữ trước thời điểm hết hạn hiển thị trong trình biên tập.

## Khi gặp lỗi

- **Chưa có khóa / không có quyền mô hình:** mở Cài đặt, lưu khóa và tên mô hình phù hợp rồi kiểm tra kết nối.
- **Thiếu công cụ:** chạy lại `npm install`, `npm run setup` và khởi động lại. Xem trạng thái hệ thống trong Cài đặt.
- **Không nhập được đường dẫn:** dùng URL công khai đầy đủ; nếu trang nguồn yêu cầu đăng nhập hoặc chặn tải, dùng video có sẵn trên máy mà bạn được phép xử lý.
- **Video lỗi, quá lớn/dài hoặc không có lời nói:** chọn tệp khác đáp ứng giới hạn. Dữ liệu đã tải lên được kiểm tra trước khi gọi AI.
- **Mất kết nối:** kiểm tra cửa sổ ứng dụng còn chạy. Dùng Thử lại/Kết nối lại; các chỉnh sửa trên màn hình không bị xóa tự động.
- **Trình duyệt không phát được nguồn:** có thể vẫn sửa phụ đề và tải MP4 đã xuất. Định dạng nguồn và MP4 kết quả có thể có khả năng phát khác nhau.
- **Kết quả hết hạn:** tải lại nguồn và tạo công việc mới; tệp hết hạn không còn để tải xuống.

## Xác minh kỹ thuật

```powershell
npm test
node --test tests/acceptance.mjs
npm run build
```

`tests/acceptance.mjs` có các ca tự động cho giao ước phía trình duyệt và danh sách kiểm tra nghiệm thu UI/E2E. Nghiệm thu hai luồng upload/URL cần khóa API hợp lệ, video có lời nói và kiểm tra MP4/SRT đến cuối video; kiểm tra kết nối riêng lẻ không thay thế các ca này.

Trạng thái bàn giao hiện tại: máy chưa có khóa API, vì vậy chưa xác minh trọn vẹn hai luồng AI trả phí. HTTP local và giao ước đã được kiểm tra; môi trường không có trình duyệt tự động khả dụng nên chưa có kiểm tra trực quan/screenshot desktop và mobile. Nhập khóa trực tiếp trong Cài đặt khi bạn muốn dùng dịch vụ AI; không cần gửi khóa trong trò chuyện.
