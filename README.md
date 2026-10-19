# VietSub Studio

Ứng dụng dịch phụ đề video chạy trên máy Windows của bạn: nhập video qua tệp hoặc đường dẫn công khai, nhận dạng lời nói, dịch, biên tập và xuất MP4 cùng SRT UTF-8. Âm thanh gốc được giữ lại. Giao diện không dùng video mẫu hoặc tiến độ mô phỏng.

## Cài đặt lần đầu

Cần Node.js 24.21 trở lên, npm và kết nối Internet để tải phụ thuộc, công cụ và gọi dịch vụ AI. Sau khi clone repo, mở PowerShell trong thư mục chứa `package.json`:

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

Trong **Cài đặt**, chọn **OpenAI** hoặc **Google Gemini** ở danh sách **Nhà cung cấp AI**, nhập khóa của nhà cung cấp đó và chọn **Mô hình dịch & viết kịch bản** từ danh sách. Bấm **Lưu cài đặt**, sau đó **Kiểm tra kết nối**. Phải lưu thay đổi nhà cung cấp, khóa hoặc mô hình trước khi kiểm tra. Mỗi nhà cung cấp giữ khóa và mô hình riêng; khi chuyển nhà cung cấp, ứng dụng nạp lại mô hình đã lưu của nhà cung cấp đó và xóa nội dung ô nhập khóa chưa lưu.

Tạo khóa OpenAI tại [OpenAI Platform](https://platform.openai.com/api-keys). Một khóa OpenAI dùng cho nhận dạng lời nói bằng `whisper-1`, dịch phụ đề và viết kịch bản bằng mô hình đã chọn. Tài khoản API có thể khác tài khoản ChatGPT đang đăng nhập; phí API tính theo dự án của khóa, riêng với gói ChatGPT. Tạo khóa Gemini tại [Google AI Studio](https://aistudio.google.com/api-keys) nếu bạn chọn Google Gemini. Âm thanh và nội dung được gửi tới nhà cung cấp đã lưu để xử lý.

**Kiểm tra kết nối** chỉ xác nhận quyền truy cập mô hình đã lưu, không tạo nội dung và không phát sinh phí tạo nội dung. Kiểm tra này chưa xác nhận hạn mức, nhận dạng lời nói hoặc toàn bộ quy trình; cần chạy video có lời nói để kiểm tra đầy đủ. Khóa không được hiển thị lại, không lưu trong localStorage và không đưa vào Git. Để trống ô thay khóa để giữ khóa hiện tại của nhà cung cấp tương ứng.

**Khóa Google API cho Veo** là trường riêng, tùy chọn. Khi chọn OpenAI, bạn chỉ cần thêm khóa Google nếu muốn tạo clip Veo; nhận dạng lời nói, dịch phụ đề và viết kịch bản vẫn dùng OpenAI. Khóa Google phải có quyền truy cập Veo; phí clip tính theo dự án Google. Ứng dụng không tự đổi nhà cung cấp khi gặp lỗi.

Các cấu hình OpenAI cũ hợp lệ tiếp tục được dùng. Nếu một khóa OpenAI trước đây bị lưu nhầm vào cấu hình Gemini, ứng dụng nhận diện và chuyển sang OpenAI mà không hiển thị khóa cho trình duyệt. Checkpoint lời nói/bản dịch hợp lệ từ công việc cũ vẫn được dùng để tiếp tục xử lý, giữ nguyên ghi nhận sử dụng trước đó.

## Dịch, sửa và tải video

1. Trong **Tạo video**, dán đường dẫn công khai hoặc chọn/kéo tệp video vào vùng tải lên. Chọn ngôn ngữ đích và kiểu phụ đề. Hình phong cảnh chỉ minh họa kiểu chữ.
2. Bấm **Dịch và tạo phụ đề**. Tiến độ hiển thị trạng thái thực tế từ bộ xử lý; mỗi lần xử lý một công việc, các video khác xếp hàng. Có thể mở lại trong **Lịch sử video**.
3. Khi có phụ đề, nhấn mốc thời gian của đoạn để tua video. Sửa bản dịch rồi bấm **Lưu phụ đề**. Nội dung chưa lưu được giữ khi mất kết nối; không đóng trình duyệt nếu còn bản sửa cần giữ.
4. Tải **SRT** sau khi lưu. Bấm **Xuất lại** để ghép phiên bản đã lưu vào MP4. MP4 bản cũ vẫn được phân biệt rõ trong lúc chưa có bản mới. Bấm **Tải MP4** khi xuất xong.

Nếu phiên khác sửa cùng phụ đề, ứng dụng giữ bản đang soạn và báo xung đột. Sao chép nội dung cần giữ rồi dùng **Nạp bản máy chủ** để đồng bộ. Các nút lưu/xuất lại không tự ghi đè phiên bản mới hơn.

Giới hạn: tối đa 25 phút và 500 MB mỗi video. Kết quả MP4 H.264/AAC tối đa 720p theo hướng nguồn, giữ tỉ lệ, không phóng lớn video nhỏ. SRT dùng UTF-8, tối đa hai dòng mỗi đoạn; câu dịch dài được cảnh báo để rút gọn. Nguồn không có âm thanh/lời nói, tệp lỗi và nội dung riêng tư/DRM có thể không xử lý được.

## Video từ ý tưởng: kịch bản, prompt và tạo từng scene

Mở **Video từ ý tưởng** để tạo video sản phẩm mới. Nhập ý tưởng, mô tả nhân vật trưởng thành, sản phẩm, phong cách và tỉ lệ khung hình. Có thể thêm hai ảnh PNG/JPEG tham chiếu (nhân vật và sản phẩm), mỗi ảnh tối đa 256 KiB. Nhà cung cấp AI đã chọn phát triển thành năm scene: cận cảnh sản phẩm → nhân vật xuất hiện → trải nghiệm sử dụng → chi tiết → kết thúc. Mỗi cảnh có thời lượng, hành động, hình ảnh và prompt gồm bối cảnh, góc máy, chuyển động máy, ánh sáng, chất liệu, cinematic và âm thanh.

Hồ sơ nhân vật/sản phẩm dùng chung được khóa sau khi tạo kịch bản. Mỗi scene có ô prompt riêng và bản prompt đầy đủ để xem/sao chép; phần nhận diện dùng chung được máy chủ ghép vào mọi yêu cầu tạo video. Muốn thay nhận diện chung, tạo dự án mới. Sửa và lưu Scene 3 chỉ cập nhật phiên bản Scene 3; bốn cảnh còn lại giữ nguyên. Dự án được lưu trên máy để mở lại; bản nháp chưa lưu được bảo vệ khi chuyển màn hình và không bị polling ghi đè.

- Luồng quản lý: **Ý tưởng → Kịch bản → Danh sách Scene → Prompt → Video Preview**; trạng thái lấy từ dữ liệu đã lưu và tiến trình thật.
- Mỗi scene có bốn nút chính: **Prompt** mở biên tập; **Generate** tạo clip còn thiếu/cũ; **Preview** chỉ xem clip đã lưu; **Regenerate** chủ động tạo lại riêng cảnh và giữ mọi bản cũ. Lưu prompt là thao tác riêng, chưa tự tạo clip.
- **Generate All Scenes:** tạo những cảnh chưa có clip khớp với phiên bản prompt hiện tại, giữ clip đã hoàn thành.
- **Generate Video:** tạo các cảnh còn thiếu rồi ghép năm clip thành MP4 theo thứ tự; khi đã đủ clip thì chỉ ghép bằng FFmpeg.

**Reset Project** đưa giao diện về ý tưởng mới, xóa dữ liệu đang nhập/chọn và bản nháp sau khi xác nhận nếu cần; không xóa dự án hoặc lịch sử đã lưu. Xóa dự án là nút riêng. **Lịch sử cảnh** lưu từng lần tạo với prompt đúng lúc gửi, thời lượng, mô hình, trạng thái và clip tương ứng; có thể chọn bản cũ để xem và so sánh prompt mà không sửa cảnh hiện tại. Những clip đã có trước khi bổ sung lịch sử vẫn được giữ để xem, không gán ngày hoặc prompt suy đoán.

Nút **Điền ví dụ** trong phần thời trang café chuẩn bị ý tưởng cô gái trưởng thành giới thiệu trang phục trong quán café hiện đại. Nút chỉ điền biểu mẫu; bạn xem lại rồi chủ động bấm tạo kịch bản. Giao diện quản lý có bố cục PC và mobile, với bốn nút scene xếp gọn thành hai cột trên màn hình hẹp.

Tạo kịch bản dùng nhà cung cấp và mô hình đã lưu trong Cài đặt. Tạo video dùng `veo-3.1-generate-preview`, có thể cấu hình bằng `GEMINI_VIDEO_MODEL`; bản `veo-3.1-fast-generate-preview` chỉ dùng khi không có ảnh tham chiếu. Veo được gọi qua API Google, không điều khiển giao diện Flow. Khóa Google cần có quyền truy cập Veo và hạn mức/gói thanh toán phù hợp. Việc tạo clip có thể phát sinh phí; mở màn hình không tự tạo clip. Thời lượng từng cảnh là 4, 6 hoặc 8 giây ở 720p; khi dùng ảnh tham chiếu, Veo yêu cầu 8 giây. Xem [tài liệu Veo chính thức](https://ai.google.dev/gemini-api/docs/veo) để đối chiếu giới hạn tài khoản và mô hình.

Prompt và ảnh tham chiếu cố định giúp giữ nhận diện xuyên suốt; mô hình sinh video không bảo đảm nhân vật hoặc sản phẩm giống tuyệt đối ở mọi khung hình. Xem lại clip từng cảnh trước khi sử dụng. Clip lỗi có thông báo riêng; không hiển thị video giả hoặc báo hoàn thành khi chưa có tệp thật.

Operation Google được lưu trên máy. Đóng tab không dừng quá trình tạo ở Google; mở lại dự án để lấy trạng thái và tải kết quả. Nếu máy chủ dừng đúng lúc gửi lệnh tạo mà chưa nhận được operation ID, ứng dụng không tự gửi lại yêu cầu có thể tính phí lần hai; kiểm tra tài khoản Google trước khi chủ động thử lại. Các clip đã thành công vẫn được giữ khi một cảnh khác lỗi. Dữ liệu scene được giữ riêng trong `.data` đến khi bạn xóa dự án; thời hạn 24 giờ của công việc phụ đề không áp dụng cho dự án scene.

Các kiểm tra kịch bản/operation dùng HTTP fixture cục bộ; ghép MP4 được kiểm tra bằng FFmpeg thật. Chưa nghiệm thu tạo kịch bản và clip bằng tài khoản Veo thật khi chưa có API key có quyền truy cập. Nhập khóa trong Cài đặt, không gửi khóa trong trò chuyện.

## Video từ giọng gốc — tính năng mới

Mở **Video từ giọng gốc** và dán link YouTube hoặc Facebook công khai. Ứng dụng lấy lời đọc trong nguồn, chia cảnh theo thời gian, tạo hình chân thực có chuyển động rồi ghép MP4 720p với âm thanh gốc. Có thể xem trước, sửa mô tả và tạo lại riêng từng cảnh. Mục này có dự án/lịch sử riêng; các chức năng hiện có giữ nguyên cách dùng.

Nhận dạng và lập cảnh dùng nhà cung cấp AI đã chọn; tạo clip cần khóa Google có quyền Veo và có thể phát sinh phí theo số cảnh. Nguồn tối đa 25 phút/500 MB. Track âm thanh nguồn được giữ cùng nhạc nền/hiệu ứng vốn có; không tạo giọng mới. Xem [hướng dẫn đầy đủ](docs/narrated.md).

## Chạy nền và tắt máy

Bản hiện tại chạy **local trên máy bạn**, truy cập tại `http://127.0.0.1:3000/#studio`. Mở `Khoi-dong.cmd` trong thư mục dự án, hoặc chạy `npm start` sau khi đã build. OpenAI/Gemini/Veo vẫn cần Internet và API key; chạy local không có nghĩa các mô hình AI chạy ngoại tuyến. Không có bước xuất bản công khai trong bản này.

Giữ cửa sổ launcher/terminal mở đến khi công việc hoàn thành. Thu nhỏ cửa sổ để tiếp tục làm việc; đóng tab trình duyệt không dừng máy chủ. Đóng cửa sổ máy chủ, nhấn Ctrl+C hoặc tắt/ngủ máy sẽ ngắt việc xử lý. Mở lại launcher để bộ xử lý kiểm tra checkpoint và khôi phục công việc hợp lệ. Không mở nhiều bản ứng dụng để tăng tốc; chỉ một video chạy mỗi lần.

## Dữ liệu và thời hạn

Dữ liệu ứng dụng, cấu hình máy chủ, cơ sở dữ liệu và các tệp công việc nằm trong `.data` bên trong thư mục `web`; công cụ tải về nằm trong `.tools`. Hai thư mục đều được loại khỏi Git. Khóa API ở cấu hình máy chủ là bí mật; hạn chế quyền truy cập máy/thư mục này. Bản gốc mà bạn tải lên từ máy không bị thay đổi.

Kết quả trên máy được giữ 24 giờ kể từ **lần xuất thành công đầu tiên**, xuất lại không gia hạn. Công việc lỗi/hủy được giữ 24 giờ từ trạng thái đó. Phiên tải lên dở được dọn sau một giờ không hoạt động. Dọn dẹp chạy mỗi 15 phút và bảo vệ tệp đang xử lý. Hãy tải MP4/SRT cần giữ trước thời điểm hết hạn hiển thị trong trình biên tập.

Thời hạn 24 giờ chỉ áp dụng dữ liệu trên máy. Khi dùng Gemini, ứng dụng yêu cầu xóa tệp âm thanh tạm trên Google sau khi xử lý; nếu xóa không thành công, [Gemini Files tự hết hạn sau 48 giờ](https://ai.google.dev/gemini-api/docs/files). Chính sách dữ liệu của nhà cung cấp vẫn áp dụng cho nội dung đã gửi.

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

Chưa xác minh hai luồng upload/URL bằng khóa API thật hoặc kiểm tra độ chính xác mốc thời gian trên video có lời nói. Các kiểm tra HTTP local dùng phản hồi AI mô phỏng để xác minh giao ước và khả năng tiếp tục checkpoint; chúng không thay thế kiểm tra dịch vụ thực tế. Nhập khóa trực tiếp trong Cài đặt; không cần gửi khóa trong trò chuyện.
