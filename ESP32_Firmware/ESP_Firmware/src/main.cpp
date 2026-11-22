#include <Arduino.h>
#include <WiFi.h>
#include <utility>
#include "esp_camera.h"
#include "img_converters.h"
#include "esp_http_server.h"
#include "Constants.h"

#define PART_BOUNDARY "123456789000000000000987654321"
static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_PART = "\r\n\
--" PART_BOUNDARY "\r\n\
Content-Type: image/jpeg\r\n\
Content-Length: %u\r\n\
\r\n";

static const int ENCODER_TASKS = 2;           // set to 1 if encoding isn't the limit
static const size_t HDR_ROOM = 128;           // space reserved for the multipart header
static const size_t JPG_BUF_SIZE = 64 * 1024; // max JPEG size

// Buffer ownership: each encoder owns one write buffer, plus one "ready"
// (newest finished frame) and one "send" buffer. Swaps happen under buf_mutex.
struct JpegBuf {
  uint8_t *mem;   // [HDR_ROOM header space][JPEG data]
  size_t len;     // JPEG length
  bool overflow;
};
static JpegBuf bufs[ENCODER_TASKS + 2];
static JpegBuf *ready_buf = &bufs[ENCODER_TASKS];
static JpegBuf *send_buf = &bufs[ENCODER_TASKS + 1];
static bool ready_fresh = false;
static uint32_t latest_id = 0;       // capture id of the newest published frame
static uint32_t capture_counter = 0;

static SemaphoreHandle_t buf_mutex;
static SemaphoreHandle_t grab_mutex;
static SemaphoreHandle_t frame_ready;

struct EncoderStats {
  volatile uint32_t frames;
  volatile uint32_t wait_us;  // time spent waiting for the camera
  volatile uint32_t enc_us;   // time spent encoding
};
static EncoderStats stats[ENCODER_TASKS];

httpd_handle_t stream_server = NULL;

static size_t jpg_write_cb(void *arg, size_t index, const void *data, size_t len) {
  JpegBuf *b = (JpegBuf *)arg;
  if (!data || !len) return 0;  // end-of-image call
  if (index + len > JPG_BUF_SIZE) {
    b->overflow = true;
    return 0;
  }
  memcpy(b->mem + HDR_ROOM + index, data, len);
  b->len = index + len;
  return len;
}

static void encoder_task(void *arg) {
  const int idx = (int)(intptr_t)arg;
  JpegBuf *w = &bufs[idx];

  for (;;) {
    uint32_t t0 = micros();

    // Grab under a mutex so capture ids follow capture order.
    xSemaphoreTake(grab_mutex, portMAX_DELAY);
    camera_fb_t *fb = esp_camera_fb_get();
    uint32_t id = ++capture_counter;
    xSemaphoreGive(grab_mutex);
    if (!fb) {
      vTaskDelay(1);
      continue;
    }
    uint32_t t1 = micros();

    w->len = 0;
    w->overflow = false;
    bool ok = frame2jpg_cb(fb, CameraConstants::QUALITY, jpg_write_cb, w);
    esp_camera_fb_return(fb);
    uint32_t t2 = micros();

    if (ok && !w->overflow && w->len > 0) {
      stats[idx].frames++;
      stats[idx].wait_us += t1 - t0;
      stats[idx].enc_us += t2 - t1;

      xSemaphoreTake(buf_mutex, portMAX_DELAY);
      if (id > latest_id) {  // drop frames that finished after a newer one
        std::swap(w, ready_buf);
        ready_fresh = true;
        latest_id = id;
      }
      xSemaphoreGive(buf_mutex);
      xSemaphoreGive(frame_ready);
    }

    vTaskDelay(1);  // let the idle task run so the task watchdog doesn't fire
  }
}

static esp_err_t stream_handler(httpd_req_t *req) {
  esp_err_t result = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (result != ESP_OK) return result;

  uint32_t sent = 0, bytes = 0;
  uint32_t prev_frames[ENCODER_TASKS], prev_wait[ENCODER_TASKS], prev_enc[ENCODER_TASKS];
  for (int i = 0; i < ENCODER_TASKS; i++) {
    prev_frames[i] = stats[i].frames;
    prev_wait[i] = stats[i].wait_us;
    prev_enc[i] = stats[i].enc_us;
  }
  uint32_t window_start = millis();

  while (true) {
    if (xSemaphoreTake(frame_ready, pdMS_TO_TICKS(1000)) != pdTRUE) continue;

    xSemaphoreTake(buf_mutex, portMAX_DELAY);
    if (!ready_fresh) {
      xSemaphoreGive(buf_mutex);
      continue;
    }
    std::swap(send_buf, ready_buf);
    ready_fresh = false;
    xSemaphoreGive(buf_mutex);

    // Write the header directly in front of the JPEG and send both at once.
    char hdr[HDR_ROOM];
    size_t hlen = snprintf(hdr, sizeof(hdr), STREAM_PART, send_buf->len);
    uint8_t *start = send_buf->mem + HDR_ROOM - hlen;
    memcpy(start, hdr, hlen);
    result = httpd_resp_send_chunk(req, (const char *)start, hlen + send_buf->len);
    if (result != ESP_OK) break;  // client disconnected

    sent++;
    bytes += send_buf->len;

    uint32_t elapsed = millis() - window_start;
    if (elapsed >= 5000) {
      Serial.printf("sent %.1f fps, %lu bytes/frame", sent * 1000.0f / elapsed, bytes / sent);
      for (int i = 0; i < ENCODER_TASKS; i++) {
        uint32_t f = stats[i].frames - prev_frames[i];
        uint32_t wt = stats[i].wait_us - prev_wait[i];
        uint32_t en = stats[i].enc_us - prev_enc[i];
        if (f) {
          Serial.printf(" | enc%d %.1f fps, wait %lu ms, encode %lu ms",
                        i, f * 1000.0f / elapsed, wt / f / 1000, en / f / 1000);
        }
        prev_frames[i] = stats[i].frames;
        prev_wait[i] = stats[i].wait_us;
        prev_enc[i] = stats[i].enc_us;
      }
      Serial.println();
      sent = bytes = 0;
      window_start = millis();
    }
  }
  return result;
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP-32");

  if (esp_camera_init(&CameraConstants::CONFIG) != ESP_OK) {
    Serial.println("Camera initialization failed");
    return;
  }
  Serial.println("Camera connected");

  for (auto &b : bufs) {
    b.mem = (uint8_t *)heap_caps_malloc(HDR_ROOM + JPG_BUF_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    b.len = 0;
    b.overflow = false;
    if (!b.mem) {
      Serial.println("JPEG buffer allocation failed");
      return;
    }
  }
  buf_mutex = xSemaphoreCreateMutex();
  grab_mutex = xSemaphoreCreateMutex();
  frame_ready = xSemaphoreCreateBinary();

  // Encoder 0 on core 1, encoder 1 on core 0 (shares it with Wi-Fi at lower priority).
  for (int i = 0; i < ENCODER_TASKS; i++) {
    xTaskCreatePinnedToCore(encoder_task, "jpg_enc", 8192, (void *)(intptr_t)i, 2, NULL, i == 0 ? 1 : 0);
  }

  WiFi.begin(WifiConstants::SSID, WifiConstants::PASSWORD);
  WiFi.setSleep(false);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (WiFi.status() == WL_CONNECT_FAILED) {
      Serial.println(" Connection Failed");
      return;
    }
  }
  Serial.println();
  Serial.println("Wifi-Connected");

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.core_id = 0;
  if (httpd_start(&stream_server, &config) == ESP_OK) {
    httpd_uri_t stream_uri = { .uri = "/stream", .method = HTTP_GET, .handler = stream_handler, .user_ctx = NULL };
    httpd_register_uri_handler(stream_server, &stream_uri);
  } else {
    Serial.println("Server start error");
  }

  Serial.println("Stream: http://" + WiFi.localIP().toString() + ":81/stream");
}

void loop() {
  delay(10000);
}
