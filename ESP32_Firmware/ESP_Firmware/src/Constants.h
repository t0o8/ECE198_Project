#include "esp_camera.h"

#ifndef CONSTANTS_H
#define CONSTANTS_H

namespace CameraConstants {
    extern const camera_config_t CONFIG;
    extern const int QUALITY;
}
namespace WifiConstants {
    extern const char* SSID;
    extern const char* PASSWORD;
}

#endif