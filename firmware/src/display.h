// display abstraction: one small api, three backends.
//   Inkplate (soldered)        -DARDUINO_INKPLATE*   3-bit grayscale, touch on 6plus via the library
//   LilyGo EPD47 (ed047tc1)    -DORBIS_EPD47         4-bit grayscale framebuffer
//   GxEPD2 (waveshare & co)    -DORBIS_GXEPD2        1-bit, class from -DORBIS_GX_CLASS
// the hub sends an "ORB1" frame: 16-byte header + rows of packed pixels, MSB first, 0 = black.
#pragma once
#include <Arduino.h>

struct OrbFrame {
  uint16_t width = 0, height = 0;
  uint8_t bits = 1;
  uint8_t flags = 0;
  uint16_t refreshMinutes = 10;
  uint32_t crc = 0;
  const uint8_t* pixels = nullptr;
  size_t pixelBytes = 0;
  bool parse(const uint8_t* buf, size_t len) {
    if (len < 16 || memcmp(buf, "ORB1", 4) != 0) return false;
    width = buf[4] | (buf[5] << 8);
    height = buf[6] | (buf[7] << 8);
    bits = buf[8];
    flags = buf[9];
    refreshMinutes = buf[10] | (buf[11] << 8);
    crc = buf[12] | (buf[13] << 8) | (buf[14] << 16) | ((uint32_t)buf[15] << 24);
    pixels = buf + 16;
    pixelBytes = len - 16;
    size_t rowBytes = (width * bits + 7) / 8;
    return pixelBytes >= rowBytes * height && (bits == 1 || bits == 2 || bits == 4 || bits == 8);
  }
  // 0 = black … 255 = white
  uint8_t gray(uint16_t x, uint16_t y) const {
    size_t rowBytes = (width * bits + 7) / 8;
    size_t bitPos = (size_t)x * bits;
    uint8_t byte = pixels[y * rowBytes + (bitPos >> 3)];
    uint8_t shift = 8 - bits - (bitPos & 7);
    uint8_t v = (byte >> shift) & ((1 << bits) - 1);
    return (uint8_t)((v * 255) / ((1 << bits) - 1));
  }
};

/* ------------------------------------------------------------------ inkplate */
#if defined(ARDUINO_INKPLATE6V2) || defined(ARDUINO_INKPLATE6PLUSV2) || defined(ARDUINO_INKPLATE10V2) || defined(ARDUINO_INKPLATECOLOR)
#include <Inkplate.h>
#if defined(ARDUINO_INKPLATECOLOR)
static Inkplate epd;
#define ORBIS_INKPLATE_MONO 1
#else
static Inkplate epd(INKPLATE_3BIT);
#endif

inline void displayBegin() {
  epd.begin();
  epd.setRotation(0);
}
inline void displayShow(const OrbFrame& f) {
  epd.clearDisplay();
  for (uint16_t y = 0; y < f.height && y < epd.height(); y++)
    for (uint16_t x = 0; x < f.width && x < epd.width(); x++) {
      uint8_t g = f.gray(x, y);
#ifdef ORBIS_INKPLATE_MONO
      if (g < 128) epd.drawPixel(x, y, INKPLATE_BLACK);
#else
      epd.drawPixel(x, y, g >> 5);  // 0..7, 0 = black on inkplate 3-bit
#endif
    }
  epd.display();
}
inline void displayMessage(const char* line1, const char* line2) {
  epd.clearDisplay();
  epd.setTextSize(3);
#ifdef ORBIS_INKPLATE_MONO
  epd.setTextColor(INKPLATE_BLACK);
#else
  epd.setTextColor(0);
#endif
  epd.setCursor(20, 40);
  epd.print(line1);
  epd.setTextSize(2);
  epd.setCursor(20, 90);
  epd.print(line2);
  epd.display();
}
inline void displaySleep() {}
inline int displayBattery() {
  double v = epd.readBattery();
  int pct = (int)((v - 3.3) / (4.2 - 3.3) * 100.0);
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}
inline uint16_t displayWidth() { return epd.width(); }
inline uint16_t displayHeight() { return epd.height(); }

/* ------------------------------------------------------------------ lilygo epd47 */
#elif defined(ORBIS_EPD47)
#include <epd_driver.h>
static uint8_t* fb = nullptr;

inline void displayBegin() {
  epd_init();
  fb = (uint8_t*)ps_calloc(EPD_WIDTH * EPD_HEIGHT / 2, 1);
  if (fb) memset(fb, 0xFF, EPD_WIDTH * EPD_HEIGHT / 2);
}
inline void displayShow(const OrbFrame& f) {
  if (!fb) return;
  memset(fb, 0xFF, EPD_WIDTH * EPD_HEIGHT / 2);
  for (uint16_t y = 0; y < f.height && y < EPD_HEIGHT; y++)
    for (uint16_t x = 0; x < f.width && x < EPD_WIDTH; x++) {
      uint8_t g = f.gray(x, y) >> 4;  // 0..15
      size_t i = (y * EPD_WIDTH + x) / 2;
      if (x & 1) fb[i] = (fb[i] & 0x0F) | (g << 4);
      else fb[i] = (fb[i] & 0xF0) | g;
    }
  epd_poweron();
  epd_clear();
  epd_draw_grayscale_image(epd_full_screen(), fb);
  epd_poweroff();
}
inline void displayMessage(const char* line1, const char* line2) {
  // no font bundled here to keep the binary small; the led/serial carries the message. a later version draws text.
  if (!fb) return;
  memset(fb, 0xFF, EPD_WIDTH * EPD_HEIGHT / 2);
  epd_poweron();
  epd_clear();
  epd_poweroff();
  Serial.printf("[display] %s / %s\n", line1, line2);
}
inline void displaySleep() { epd_poweroff_all(); }
inline int displayBattery() {
  // t5 4.7: battery on gpio 36 through a 1:2 divider
  analogReadResolution(12);
  int raw = analogRead(36);
  float v = raw / 4095.0f * 3.3f * 2.0f;
  int pct = (int)((v - 3.3f) / (4.2f - 3.3f) * 100.0f);
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}
inline uint16_t displayWidth() { return EPD_WIDTH; }
inline uint16_t displayHeight() { return EPD_HEIGHT; }

/* ------------------------------------------------------------------ gxepd2 (waveshare driver board pins) */
#elif defined(ORBIS_GXEPD2)
#include <GxEPD2_BW.h>
// waveshare esp32 e-paper driver board: BUSY 25, RST 26, DC 27, CS 15, CLK 13, DIN 14
#ifndef ORBIS_PIN_CS
#define ORBIS_PIN_CS 15
#define ORBIS_PIN_DC 27
#define ORBIS_PIN_RST 26
#define ORBIS_PIN_BUSY 25
#define ORBIS_PIN_CLK 13
#define ORBIS_PIN_DIN 14
#endif
static GxEPD2_BW<ORBIS_GX_CLASS, ORBIS_GX_CLASS::HEIGHT> epd(ORBIS_GX_CLASS(ORBIS_PIN_CS, ORBIS_PIN_DC, ORBIS_PIN_RST, ORBIS_PIN_BUSY));

inline void displayBegin() {
  SPI.begin(ORBIS_PIN_CLK, -1, ORBIS_PIN_DIN, ORBIS_PIN_CS);
  epd.init(115200, true, 2, false);
  epd.setRotation(0);
}
inline void displayShow(const OrbFrame& f) {
  epd.setFullWindow();
  epd.firstPage();
  do {
    epd.fillScreen(GxEPD_WHITE);
    for (uint16_t y = 0; y < f.height && y < epd.height(); y++)
      for (uint16_t x = 0; x < f.width && x < epd.width(); x++)
        if (f.gray(x, y) < 128) epd.drawPixel(x, y, GxEPD_BLACK);
  } while (epd.nextPage());
}
inline void displayMessage(const char* line1, const char* line2) {
  epd.setFullWindow();
  epd.firstPage();
  do {
    epd.fillScreen(GxEPD_WHITE);
    epd.setTextColor(GxEPD_BLACK);
    epd.setTextSize(3);
    epd.setCursor(16, 30);
    epd.print(line1);
    epd.setTextSize(2);
    epd.setCursor(16, 70);
    epd.print(line2);
  } while (epd.nextPage());
}
inline void displaySleep() { epd.hibernate(); }
inline int displayBattery() { return -1; }  // driver board has no battery sense
inline uint16_t displayWidth() { return epd.width(); }
inline uint16_t displayHeight() { return epd.height(); }

#else
#error "no display backend selected (see platformio.ini envs)"
#endif
