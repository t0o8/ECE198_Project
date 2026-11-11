#include <Arduino.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "Constants.h"
#include "esp_http_server.h"

#define PART_BOUNDARY "123456789000000000000987654321"
static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_PART = "\r\n\--" PART_BOUNDARY "\r\n\Content-Type: image/jpeg\r\n\Content-Length: %u\r\n\\r\n";

httpd_handle_t server_handle = NULL;
esp_err_t GetJPEGImage(uint8_t *&buffer, size_t &size) {
  camera_fb_t *frame_buffer = esp_camera_fb_get();
  if (!frame_buffer) {
    return ESP_FAIL;
  }

  bool convert_success = fmt2jpg(frame_buffer->buf, frame_buffer->len, frame_buffer->width, frame_buffer->height, frame_buffer->format, CameraConstants::QUALITY, &buffer, &size);
  
  esp_camera_fb_return(frame_buffer);

  if (!convert_success) {
    Serial.println("Conversion Failed");
    return ESP_FAIL;
  }

  return ESP_OK;
}

static esp_err_t stream_handler(httpd_req_t *req) {
  esp_err_t result = ESP_OK;
  result = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);

  if (result != ESP_OK) {
    return result;
  }

  while (true) {
    uint8_t *buffer{nullptr};
    size_t size{0};
    if (GetJPEGImage(buffer, size) != ESP_OK) {
      Serial.println("Skipping bad frame...");
      delay(50);
      continue; 
    }
    char str_buf[128];
    size_t hlen = snprintf(str_buf, sizeof(str_buf), STREAM_PART, size);
    result = httpd_resp_send_chunk(req, (const char *)str_buf, hlen);
    if (result != ESP_OK) {
      free(buffer);
      return result;
    }
    result = httpd_resp_send_chunk(req, (const char *)buffer, size);
    free(buffer);

    if(result != ESP_OK) break;
  }
  return result;
}


void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP-32");

  if (esp_camera_init(&CameraConstants::CONFIG) != ESP_OK) {
    Serial.println("Camera initilization failed");
    return;
  } else {
    Serial.println("Camera connected");
  }
  sensor_t *s = esp_camera_sensor_get();
  Serial.printf("Sensor PID: 0x%04Xz", s->id.PID);
// 0x26 = OV2640, 0x3660 = OV3660, 0x2145 = GC2145, 0x9B = GC0308, 0x232 = GC032A

  

  WiFi.begin(WifiConstants::SSID, WifiConstants::PASSWORD);

  if (WiFi.status() == WL_NO_SHIELD) {
    Serial.println("Shield Missing");
  }

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (WiFi.status() == WL_CONNECT_FAILED) {
      Serial.println(" Connection Failed");
      return;
    }
  }
  Serial.println("");
  Serial.println("Wifi-Connected");
  Serial.println("Camera IP: " + WiFi.localIP());
 
  httpd_config_t server_config = HTTPD_DEFAULT_CONFIG();
  server_config.server_port = 81;

  if (httpd_start(&server_handle, &server_config) == ESP_OK) {
    httpd_uri_t stream_uri = { .uri = "/stream", .method = HTTP_GET, .handler = stream_handler, .user_ctx = NULL };
    httpd_register_uri_handler(server_handle, &stream_uri);
  } else {
    Serial.println("Server start error");
  }
  Serial.print("Camera stream ready. Open to http://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/stream");
}

void loop() {
  delay(10000);
  
}
