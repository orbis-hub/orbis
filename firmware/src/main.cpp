// orbis e-ink firmware
//
// boot → (first run) wifi portal "orbis-eink" asks for wifi + hub url + display id + token
//      → fetch <hub>/api/eink/<id>.bin ("ORB1" frame) → draw → deep sleep for <refreshMinutes>
//      → touch boards: stay awake ~20 s after a refresh, send taps to the hub, refresh when it says so
//
// hold BOOT (gpio 0) while powering on to reopen the portal. serial 115200 for logs.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_sleep.h>
#include "display.h"
#include "touch.h"

#ifndef ORBIS_BOARD
#define ORBIS_BOARD "custom"
#endif
#ifndef ORBIS_FW_VERSION
#define ORBIS_FW_VERSION "dev"
#endif

static Preferences prefs;
static String hubUrl, displayId, token;
static const char* touchKind = nullptr;
static RTC_DATA_ATTR uint32_t lastCrc = 0;
static RTC_DATA_ATTR uint16_t failures = 0;

static void saveConfig(const String& url, const String& id, const String& tok) {
  prefs.begin("orbis", false);
  prefs.putString("hub", url);
  prefs.putString("id", id);
  prefs.putString("token", tok);
  prefs.end();
}
static bool loadConfig() {
  prefs.begin("orbis", true);
  hubUrl = prefs.getString("hub", "");
  displayId = prefs.getString("id", "");
  token = prefs.getString("token", "");
  prefs.end();
  while (hubUrl.endsWith("/")) hubUrl.remove(hubUrl.length() - 1);
  return hubUrl.length() && displayId.length() && token.length();
}

static void portal(bool force) {
  WiFiManager wm;
  wm.setTitle("orbis e-ink");
  wm.setConfigPortalTimeout(300);
  WiFiManagerParameter pHub("hub", "hub url (http://192.168.1.20:3001)", hubUrl.c_str(), 96);
  WiFiManagerParameter pId("id", "display id", displayId.c_str(), 32);
  WiFiManagerParameter pTok("token", "display token", token.c_str(), 64);
  wm.addParameter(&pHub);
  wm.addParameter(&pId);
  wm.addParameter(&pTok);
  displayMessage("orbis e-ink", "wifi: orbis-eink  ->  192.168.4.1");
  bool ok = force ? wm.startConfigPortal("orbis-eink") : wm.autoConnect("orbis-eink");
  if (!ok) {
    Serial.println("[wifi] portal timed out, sleeping 10 min");
    esp_sleep_enable_timer_wakeup(10ULL * 60 * 1000000ULL);
    esp_deep_sleep_start();
  }
  String h = pHub.getValue(), i = pId.getValue(), t = pTok.getValue();
  if (h.length() && i.length() && t.length()) saveConfig(h, i, t);
  loadConfig();
}

static bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin();  // credentials stored by wifimanager
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  return WiFi.status() == WL_CONNECTED;
}

static void addHeaders(HTTPClient& http) {
  http.addHeader("Authorization", "Bearer " + token);
  http.addHeader("X-Orbis-Board", ORBIS_BOARD);
  http.addHeader("X-Orbis-Firmware", ORBIS_FW_VERSION);
  int bat = displayBattery();
  if (bat >= 0) http.addHeader("X-Orbis-Battery", String(bat));
  if (touchKind) http.addHeader("X-Orbis-Touch", touchKind);
}

// returns minutes until the next refresh, 0 on failure
static uint16_t fetchAndShow() {
  HTTPClient http;
  http.setTimeout(20000);
  String url = hubUrl + "/api/eink/" + displayId + ".bin";
  http.begin(url);
  addHeaders(http);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[hub] GET %s -> %d\n", url.c_str(), code);
    http.end();
    if (code == 401) displayMessage("orbis: not paired", "wrong token or display id. hold BOOT at power-on to reconfigure.");
    return 0;
  }
  int len = http.getSize();
  if (len <= 16 || len > 2 * 1024 * 1024) {
    http.end();
    return 0;
  }
  uint8_t* buf = (uint8_t*)(psramFound() ? ps_malloc(len) : malloc(len));
  if (!buf) {
    http.end();
    Serial.println("[hub] out of memory");
    return 0;
  }
  WiFiClient* s = http.getStreamPtr();
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < (size_t)len && millis() - t0 < 30000) {
    size_t n = s->available();
    if (n) got += s->readBytes(buf + got, min(n, (size_t)len - got));
    else delay(5);
  }
  http.end();
  OrbFrame f;
  if (got != (size_t)len || !f.parse(buf, got)) {
    Serial.printf("[hub] bad frame (%u/%d bytes)\n", (unsigned)got, len);
    free(buf);
    return 0;
  }
  if (f.crc != lastCrc) {
    Serial.printf("[display] %ux%u %u-bit, drawing\n", f.width, f.height, f.bits);
    displayShow(f);
    lastCrc = f.crc;
  } else {
    Serial.println("[display] unchanged, skipping redraw");
  }
  uint16_t minutes = f.refreshMinutes ? f.refreshMinutes : 10;
  free(buf);
  return minutes;
}

static bool sendTap(uint16_t x, uint16_t y) {
  HTTPClient http;
  http.begin(hubUrl + "/api/eink/" + displayId + "/tap");
  addHeaders(http);
  http.addHeader("Content-Type", "application/json");
  String body = "{\"x\":" + String(x) + ",\"y\":" + String(y) + "}";
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  return code == 200 && resp.indexOf("\"refresh\":true") >= 0;
}

static void sleepFor(uint16_t minutes) {
  touchSleep();
  displaySleep();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  Serial.printf("[sleep] %u min\n", minutes);
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t)minutes * 60ULL * 1000000ULL);
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_0, 0);  // BOOT button wakes too
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.printf("\norbis e-ink %s (%s)\n", ORBIS_FW_VERSION, ORBIS_BOARD);
  pinMode(0, INPUT_PULLUP);
  displayBegin();
  touchKind = touchBegin();

  bool forcePortal = digitalRead(0) == LOW;
  if (!loadConfig() || forcePortal) portal(true);
  else if (!connectWifi()) {
    failures++;
    if (failures > 5) portal(true);
    else {
      Serial.println("[wifi] no connection, retry in 5 min");
      sleepFor(5);
    }
  }
  failures = 0;

  uint16_t minutes = fetchAndShow();
  if (minutes == 0) {
    minutes = 5;  // back off a little on errors
  }

  if (touchKind) {
    // stay awake briefly so a tap right after a refresh works; taps extend the window
    uint32_t until = millis() + 20000;
    while (millis() < until) {
      TouchPoint p = touchRead();
      if (p.pressed) {
        Serial.printf("[touch] %u,%u\n", p.x, p.y);
        if (sendTap(p.x, p.y)) fetchAndShow();
        until = millis() + 20000;
        delay(300);
      }
      delay(30);
    }
  }
  sleepFor(minutes);
}

void loop() {}
