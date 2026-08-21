/*
  ============================================================
  ESP32 MUSIC BOX
  ============================================================

  Features:

  - ESP32 Wi-Fi
  - ESPAsyncWebServer
  - React webapp served from LittleFS
  - Direct .gz static-file serving
  - Correct gzip Content-Encoding
  - Browser caching for hashed assets
  - No-cache index.html
  - React API compatibility
  - OLED power-controlled by webapp
  - Scrolling song name
  - Progress bar (pauses when song is paused)
  - Wi-Fi reconnect handling
  - mDNS: http://musicbox.local
  - No diagnostics
  - No synchronous HTTP handling
  - No repeated WiFi.begin() calls
  - Reduced LittleFS filesystem overhead
  - API endpoints take priority over static files
  - OLED refresh is throttled
  - OLED remains completely OFF while power is OFF

  React API:

      GET  /api/status
      POST /api/power/on
      POST /api/power/off
      POST /api/select?index=N&name=<song>
      POST /api/play
      POST /api/pause
      POST /api/stop

  Static files:

      /
      /index.html
      /assets/...

  GZIP:

      /assets/index-xxxx.js.gz

  will be served for:

      /assets/index-xxxx.js

  when the .gz file exists.

  ============================================================
*/


// ============================================================
// LIBRARIES
// ============================================================

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>


// ============================================================
// WIFI
// ============================================================

const char* WIFI_SSID = "Okay";
const char* WIFI_PASSWORD = "fourwordsallcaps";
const char* HOSTNAME = "musicbox";


// ============================================================
// ASYNC WEB SERVER
// ============================================================

AsyncWebServer server(80);


// ============================================================
// OLED
// ============================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
#define OLED_RESET -1
#define OLED_ADDRESS 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);


// ============================================================
// POWER CONTROL
// ============================================================

// Set this to the GPIO controlling the music-box power.
// Leave at -1 if power is controlled externally.
#define POWER_PIN -1

bool musicBoxPower = false;


// ============================================================
// OLED STATE
// ============================================================

bool oledInitialized = false;
bool oledEnabled = false;


// ============================================================
// SONG / DISPLAY STATE
// ============================================================

String filename = "";
bool isPlaying = false;
bool hasSong = false;
int songIndex = -1;


// ============================================================
// FILENAME SCROLLING
// ============================================================

int scrollX = 0;
int textWidth = 0;

const unsigned long FILENAME_SCROLL_INTERVAL_MS = 50;
const unsigned long START_PAUSE_MS = 1500;
const unsigned long END_PAUSE_MS = 1500;

unsigned long lastScrollTime = 0;
unsigned long pauseStartTime = 0;


// IMPORTANT:
//
// These names deliberately do NOT match the timing constants.
//
// Otherwise Arduino/C++ reports:
//
// START_PAUSE redeclared as different kind of entity

enum ScrollState {
  SCROLL_START_PAUSE,
  SCROLL_MOVING,
  SCROLL_END_PAUSE
};

ScrollState scrollState = SCROLL_START_PAUSE;


// ============================================================
// PROGRESS
// ============================================================

float progress = 0.0f;
unsigned long lastProgressTime = 0;
const unsigned long PROGRESS_INTERVAL_MS = 100;


// ============================================================
// OLED REFRESH
// ============================================================

// The SSD1306 128x32 display is only 512 bytes, but sending
// the whole framebuffer over I2C is still considerably slower
// than changing RAM. 100 ms prevents OLED updates from
// unnecessarily competing with HTTP traffic.

unsigned long lastDisplayTime = 0;
const unsigned long DISPLAY_INTERVAL_MS = 100;


// ============================================================
// WIFI STATE
// ============================================================

enum WifiState {
  WIFI_DISCONNECTED,
  WIFI_CONNECTING,
  WIFI_CONNECTED
};

volatile WifiState wifiState = WIFI_DISCONNECTED;
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;


// ============================================================
// LITTLEFS STATE
// ============================================================

bool littleFSReady = false;


// ============================================================
// FORWARD DECLARATIONS
// ============================================================

void updateDisplay();
void oledOn();
void oledOff();
void setMusicBoxPower(bool power);
void setupWebServer();
void maintainWiFi();
void startMDNS();
void handleStaticFile(AsyncWebServerRequest* request);
void updateFilenameScroll(unsigned long now);
void updateProgress(unsigned long now);
void handlePlay(AsyncWebServerRequest* request);
void handlePause(AsyncWebServerRequest* request);
void handleStop(AsyncWebServerRequest* request);
void handleSelect(AsyncWebServerRequest* request);


// ============================================================
// MIME TYPE
// ============================================================

const char* getContentType(const String& path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg")) return "image/jpeg";
  if (path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}


// ============================================================
// FILE EXISTENCE
// ============================================================
//
// Used only when resolving a static request.
// Not called from API handlers.

bool littleFSFileExists(const String& path) {
  if (!littleFSReady) return false;
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  bool valid = !file.isDirectory();
  file.close();
  return valid;
}


// ============================================================
// STATIC FILE HANDLER
// ============================================================

void handleStaticFile(AsyncWebServerRequest* request) {
  if (!littleFSReady) {
    request->send(503, "text/plain", "LittleFS unavailable");
    return;
  }

  String requestPath = request->url();
  if (requestPath.length() == 0) requestPath = "/";

  if (requestPath.indexOf("..") >= 0) {
    request->send(400, "text/plain", "Bad request");
    return;
  }

  if (requestPath.startsWith("/api/")) {
    request->send(404, "text/plain", "API endpoint not found");
    return;
  }

  if (requestPath == "/") requestPath = "/index.html";

  String originalPath = requestPath;
  String gzipPath = originalPath + ".gz";
  bool useGzip = false;

  if (littleFSFileExists(gzipPath)) {
    useGzip = true;
  }

  if (!useGzip && !littleFSFileExists(originalPath)) {
    bool looksLikeFile =
      requestPath.lastIndexOf('.') > requestPath.lastIndexOf('/');

    if (!looksLikeFile) {
      originalPath = "/index.html";
      gzipPath = "/index.html.gz";

      if (littleFSFileExists(gzipPath)) {
        useGzip = true;
      } else if (!littleFSFileExists(originalPath)) {
        request->send(404, "text/plain", "index.html not found");
        return;
      }
    } else {
      request->send(404, "text/plain", "File not found");
      return;
    }
  }

  const char* contentType = getContentType(originalPath);

  AsyncWebServerResponse* response = nullptr;

  if (useGzip) {
    response = request->beginResponse(LittleFS, gzipPath, contentType);
  } else {
    response = request->beginResponse(LittleFS, originalPath, contentType);
  }

  if (!response) {
    request->send(500, "text/plain", "Failed to create file response");
    return;
  }

  if (useGzip) {
    response->addHeader("Content-Encoding", "gzip");
    response->addHeader("Vary", "Accept-Encoding");
  }

  if (originalPath == "/index.html") {
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response->addHeader("Pragma", "no-cache");
    response->addHeader("Expires", "0");
  } else {
    response->addHeader("Cache-Control", "public, max-age=31536000, immutable");
  }

  response->addHeader("X-Content-Type-Options", "nosniff");
  request->send(response);
}


// ============================================================
// CALCULATE FILENAME WIDTH
// ============================================================

void calculateFilenameWidth() {
  if (!oledInitialized) return;

  int16_t x1, y1;
  uint16_t w, h;

  display.getTextBounds(filename, 0, 0, &x1, &y1, &w, &h);
  textWidth = (int)w;
}


// ============================================================
// RESET FILENAME SCROLL
// ============================================================

void resetFilenameScroll() {
  scrollX = 0;
  scrollState = SCROLL_START_PAUSE;
  pauseStartTime = millis();
  lastScrollTime = millis();
}


// ============================================================
// OLED ON
// ============================================================

void oledOn() {
  if (!oledInitialized) return;
  if (oledEnabled) return;

  oledEnabled = true;

  display.ssd1306_command(SSD1306_DISPLAYON);

  calculateFilenameWidth();
  resetFilenameScroll();

  progress = 0.0f;
  lastProgressTime = millis();
  lastDisplayTime = 0;

  updateDisplay();
}


// ============================================================
// OLED OFF
// ============================================================

void oledOff() {
  if (!oledInitialized) return;
  if (!oledEnabled) return;

  oledEnabled = false;

  display.clearDisplay();
  display.display();
  display.ssd1306_command(SSD1306_DISPLAYOFF);
}


// ============================================================
// MUSIC BOX POWER
// ============================================================

void setMusicBoxPower(bool power) {
  musicBoxPower = power;

  if (POWER_PIN >= 0) {
    digitalWrite(POWER_PIN, power ? HIGH : LOW);
  }

  if (power) {
    oledOn();
  } else {
    isPlaying = false;
    hasSong = false;
    songIndex = -1;
    filename = "";
    progress = 0.0f;
    oledOff();
  }
}


// ============================================================
// OLED DISPLAY
// ============================================================

void updateDisplay() {
  if (!oledInitialized) return;
  if (!oledEnabled) return;

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setTextWrap(false);

  if (!hasSong) {
    // Vertically centered on 32px screen (text is 8px tall)
    display.setCursor(0, 12);
    display.print("Please select a song");
  } else {
    // Row 1 (y=0): scrolling song name
    display.setCursor(scrollX, 0);
    display.print(filename);

    // Row 2 (y=12): playback status
    display.setCursor(0, 12);
    display.print(isPlaying ? "Playing..." : "Paused");

    // Row 3 (y=24): progress bar
    const int barX = 0;
    const int barY = 24;
    const int barWidth = 128;
    const int barHeight = 7;

    display.drawRect(barX, barY, barWidth, barHeight, SSD1306_WHITE);

    float safeProgress = progress;
    if (safeProgress < 0.0f) safeProgress = 0.0f;
    if (safeProgress > 1.0f) safeProgress = 1.0f;

    int fillWidth = (int)((barWidth - 2) * safeProgress);
    if (fillWidth > 0) {
      display.fillRect(barX + 1, barY + 1, fillWidth, barHeight - 2, SSD1306_WHITE);
    }
  }

  display.display();
}


// ============================================================
// FILENAME SCROLL
// ============================================================

void updateFilenameScroll(unsigned long now) {
  if (!oledEnabled) return;
  if (!hasSong) return;

  if (textWidth <= SCREEN_WIDTH) {
    scrollX = 0;
    return;
  }

  switch (scrollState) {
    case SCROLL_START_PAUSE:
      if (now - pauseStartTime >= START_PAUSE_MS) {
        scrollState = SCROLL_MOVING;
        lastScrollTime = now;
      }
      break;

    case SCROLL_MOVING:
      if (now - lastScrollTime >= FILENAME_SCROLL_INTERVAL_MS) {
        lastScrollTime = now;
        scrollX--;

        if (scrollX <= SCREEN_WIDTH - textWidth) {
          scrollX = SCREEN_WIDTH - textWidth;
          scrollState = SCROLL_END_PAUSE;
          pauseStartTime = now;
        }
      }
      break;

    case SCROLL_END_PAUSE:
      if (now - pauseStartTime >= END_PAUSE_MS) {
        scrollX = 0;
        scrollState = SCROLL_START_PAUSE;
        pauseStartTime = now;
      }
      break;
  }
}


// ============================================================
// MOCK PROGRESS
// ============================================================

void updateProgress(unsigned long now) {
  if (!oledEnabled) return;
  if (!isPlaying) return;
  if (now - lastProgressTime < PROGRESS_INTERVAL_MS) return;

  lastProgressTime = now;
  progress += 0.005f;

  if (progress >= 1.0f) progress = 0.0f;
}


// ============================================================
// WIFI EVENT
// ============================================================

void WiFiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      wifiState = WIFI_DISCONNECTED;
      Serial.println("[WiFi] STA started");
      break;

    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[WiFi] Connected to AP");
      break;

    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      wifiState = WIFI_CONNECTED;
      Serial.println();
      Serial.println("[WiFi] GOT IP");
      Serial.print("[WiFi] IP: ");
      Serial.println(WiFi.localIP());
      Serial.print("[WiFi] RSSI: ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
      startMDNS();
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      wifiState = WIFI_DISCONNECTED;
      Serial.println("[WiFi] Disconnected");
      break;

    default:
      break;
  }
}


// ============================================================
// MDNS
// ============================================================

void startMDNS() {
  MDNS.end();
  delay(10);

  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.print("[mDNS] http://");
    Serial.print(HOSTNAME);
    Serial.println(".local");
  } else {
    Serial.println("[mDNS] Failed");
  }
}


// ============================================================
// BEGIN WIFI
// ============================================================

void beginWiFi() {
  wifiState = WIFI_CONNECTING;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(HOSTNAME);
  WiFi.setAutoReconnect(true);

  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);

  // IMPORTANT: WiFi.begin() is called only here.
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  lastReconnectAttempt = millis();
}


// ============================================================
// MAINTAIN WIFI
// ============================================================

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiState = WIFI_CONNECTED;
    return;
  }

  if (wifiState == WIFI_CONNECTING) return;

  unsigned long now = millis();

  if (now - lastReconnectAttempt < RECONNECT_INTERVAL_MS) return;

  lastReconnectAttempt = now;
  wifiState = WIFI_CONNECTING;

  Serial.println("[WiFi] Reconnecting...");

  // DO NOT call WiFi.begin() — reuse existing configuration.
  WiFi.reconnect();
}


// ============================================================
// JSON ESCAPE
// ============================================================

void appendJsonEscaped(String& output, const String& input) {
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    switch (c) {
      case '"':  output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\n': output += "\\n";  break;
      case '\r': output += "\\r";  break;
      case '\t': output += "\\t";  break;
      default:   output += c;      break;
    }
  }
}


// ============================================================
// API STATUS
// ============================================================

void handleStatus(AsyncWebServerRequest* request) {
  String json;
  json.reserve(512);

  json += "{";

  json += "\"powerOn\":";
  json += musicBoxPower ? "true" : "false";

  json += ",\"filename\":\"";
  appendJsonEscaped(json, filename);
  json += "\"";

  json += ",\"progress\":";
  json += String(progress, 3);

  json += ",\"playing\":";
  json += isPlaying ? "true" : "false";

  json += ",\"hasSong\":";
  json += hasSong ? "true" : "false";

  json += ",\"songIndex\":";
  json += String(songIndex);

  json += ",\"wifi\":";
  json += WiFi.status() == WL_CONNECTED ? "true" : "false";

  json += "}";

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", json);

  if (!response) {
    request->send(500);
    return;
  }

  response->addHeader("Cache-Control", "no-store");
  response->addHeader("X-Content-Type-Options", "nosniff");
  request->send(response);
}


// ============================================================
// API POWER ON
// ============================================================

void handlePowerOn(AsyncWebServerRequest* request) {
  setMusicBoxPower(true);

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"powerOn\":true}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API POWER OFF
// ============================================================

void handlePowerOff(AsyncWebServerRequest* request) {
  setMusicBoxPower(false);

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"powerOn\":false}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API SELECT
// ============================================================

void handleSelect(AsyncWebServerRequest* request) {
  if (request->hasParam("name")) {
    filename = request->getParam("name")->value();
    hasSong = true;
    isPlaying = true;
    progress = 0.0f;
    lastProgressTime = millis();
    calculateFilenameWidth();
    resetFilenameScroll();
  }

  if (request->hasParam("index")) {
    songIndex = request->getParam("index")->value().toInt();
  }

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"ok\":true}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API PLAY
// ============================================================

void handlePlay(AsyncWebServerRequest* request) {
  if (hasSong) {
    isPlaying = true;
    lastProgressTime = millis();
  }

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"ok\":true}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API PAUSE
// ============================================================

void handlePause(AsyncWebServerRequest* request) {
  isPlaying = false;

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"ok\":true}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API STOP
// ============================================================

void handleStop(AsyncWebServerRequest* request) {
  isPlaying = false;
  hasSong = false;
  songIndex = -1;
  filename = "";
  progress = 0.0f;
  resetFilenameScroll();

  AsyncWebServerResponse* response =
    request->beginResponse(200, "application/json", "{\"ok\":true}");

  response->addHeader("Cache-Control", "no-store");
  request->send(response);
}


// ============================================================
// API TEST
// ============================================================

void handleTest(AsyncWebServerRequest* request) {
  request->send(200, "text/plain", "Music Box ESP32 server is working!");
}


// ============================================================
// WEB SERVER
// ============================================================

void setupWebServer() {
  // API routes first
  server.on("/api/status",   HTTP_GET,  handleStatus);
  server.on("/api/power/on", HTTP_POST, handlePowerOn);
  server.on("/api/power/off",HTTP_POST, handlePowerOff);
  server.on("/api/select",   HTTP_POST, handleSelect);
  server.on("/api/play",     HTTP_POST, handlePlay);
  server.on("/api/pause",    HTTP_POST, handlePause);
  server.on("/api/stop",     HTTP_POST, handleStop);
  server.on("/api/test",     HTTP_GET,  handleTest);

  // Static files
  server.onNotFound(handleStaticFile);

  server.begin();

  Serial.println("[HTTP] Async server started");
}


// ============================================================
// SETUP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("==========================================");
  Serial.println("          ESP32 MUSIC BOX");
  Serial.println("==========================================");

  // Power GPIO
  if (POWER_PIN >= 0) {
    pinMode(POWER_PIN, OUTPUT);
    digitalWrite(POWER_PIN, LOW);
  }

  musicBoxPower = false;

  // OLED
  Serial.println("[OLED] Initializing...");

  Wire.begin(21, 22);
  Wire.setClock(400000);  // 400 kHz I2C

  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    oledInitialized = true;
    Serial.println("[OLED] Initialized");

    display.clearDisplay();
    display.display();

    // IMPORTANT: OLED starts OFF.
    // Turned on only by POST /api/power/on.
    display.ssd1306_command(SSD1306_DISPLAYOFF);
    oledEnabled = false;
  } else {
    oledInitialized = false;
    Serial.println("[OLED] Initialization failed");
  }

  // LittleFS
  Serial.println();
  Serial.println("[LittleFS] Mounting...");

  if (LittleFS.begin(false)) {
    littleFSReady = true;
    Serial.println("[LittleFS] Mounted");

    if (LittleFS.exists("/index.html")) {
      Serial.println("[LittleFS] index.html found");
    } else if (LittleFS.exists("/index.html.gz")) {
      Serial.println("[LittleFS] index.html.gz found");
    } else {
      Serial.println("[LittleFS] WARNING: index.html missing");
    }
  } else {
    littleFSReady = false;
    Serial.println("[LittleFS] Mount FAILED");
  }

  // Scroll state
  calculateFilenameWidth();
  resetFilenameScroll();

  // WiFi
  WiFi.onEvent(WiFiEvent);
  beginWiFi();

  // Web server
  setupWebServer();

  Serial.println();
  Serial.println("==========================================");
  Serial.println("Startup complete.");
  Serial.println("OLED is OFF.");
  Serial.println("OLED will turn on after POST /api/power/on.");
  Serial.println("==========================================");
}


// ============================================================
// LOOP
// ============================================================

void loop() {
  unsigned long now = millis();

  maintainWiFi();
  updateFilenameScroll(now);
  updateProgress(now);

  if (oledEnabled && now - lastDisplayTime >= DISPLAY_INTERVAL_MS) {
    lastDisplayTime = now;
    updateDisplay();
  }

  delay(1);
}
