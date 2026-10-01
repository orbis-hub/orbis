// touch: detected at boot, not configured.
//   - inkplate 6plus: the inkplate library's touchscreen (ORBIS_TOUCH_INKPLATE)
//   - any board with an i2c touch controller (ORBIS_TOUCH_I2C + ORBIS_SDA/SCL): scans for GT911 (0x5D / 0x14) and
//     FT6x36 (0x38), the two controllers used on lilygo, waveshare touch panels and most generic e-paper touch overlays.
// a board without touch compiles to no-ops.
#pragma once
#include <Arduino.h>

struct TouchPoint {
  bool pressed = false;
  uint16_t x = 0, y = 0;
};

#if defined(ORBIS_TOUCH_INKPLATE)
#include <Inkplate.h>
extern Inkplate epd;
inline const char* touchBegin() {
  if (epd.touchscreen.init(true)) return "inkplate";
  return nullptr;
}
inline TouchPoint touchRead() {
  TouchPoint p;
  if (epd.touchscreen.available()) {
    uint16_t x[2], y[2];
    uint8_t n = epd.touchscreen.getData(x, y);
    if (n > 0) {
      p.pressed = true;
      p.x = x[0];
      p.y = y[0];
    }
  }
  return p;
}
inline void touchSleep() { epd.touchscreen.shutdown(); }

#elif defined(ORBIS_TOUCH_I2C)
#include <Wire.h>
#ifndef ORBIS_SDA
#define ORBIS_SDA 21
#define ORBIS_SCL 22
#endif
static uint8_t touchAddr = 0;
static enum { TOUCH_NONE, TOUCH_GT911, TOUCH_FT6X36 } touchCtl = TOUCH_NONE;

static bool i2cPing(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}
static bool gtRead(uint16_t reg, uint8_t* buf, size_t len) {
  Wire.beginTransmission(touchAddr);
  Wire.write(reg >> 8);
  Wire.write(reg & 0xFF);
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom(touchAddr, (uint8_t)len);
  for (size_t i = 0; i < len && Wire.available(); i++) buf[i] = Wire.read();
  return true;
}
static void gtWrite(uint16_t reg, uint8_t v) {
  Wire.beginTransmission(touchAddr);
  Wire.write(reg >> 8);
  Wire.write(reg & 0xFF);
  Wire.write(v);
  Wire.endTransmission();
}
static bool ftRead(uint8_t reg, uint8_t* buf, size_t len) {
  Wire.beginTransmission(touchAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom(touchAddr, (uint8_t)len);
  for (size_t i = 0; i < len && Wire.available(); i++) buf[i] = Wire.read();
  return true;
}

inline const char* touchBegin() {
  Wire.begin(ORBIS_SDA, ORBIS_SCL);
#ifdef ORBIS_TOUCH_INT
  pinMode(ORBIS_TOUCH_INT, INPUT);
#endif
  for (uint8_t a : {0x5D, 0x14}) {
    if (i2cPing(a)) {
      touchAddr = a;
      touchCtl = TOUCH_GT911;
      uint8_t id[4] = {0};
      gtRead(0x8140, id, 4);
      Serial.printf("[touch] gt911 at 0x%02X id %c%c%c%c\n", a, id[0], id[1], id[2], id[3]);
      return "gt911";
    }
  }
  if (i2cPing(0x38)) {
    touchAddr = 0x38;
    touchCtl = TOUCH_FT6X36;
    Serial.println("[touch] ft6x36 at 0x38");
    return "ft6x36";
  }
  Serial.println("[touch] no controller found on i2c");
  return nullptr;
}

inline TouchPoint touchRead() {
  TouchPoint p;
  if (touchCtl == TOUCH_GT911) {
    uint8_t st = 0;
    if (!gtRead(0x814E, &st, 1)) return p;
    if (st & 0x80) {
      uint8_t n = st & 0x0F;
      if (n > 0) {
        uint8_t d[8];
        gtRead(0x8150, d, 8);
        p.pressed = true;
        p.x = d[0] | (d[1] << 8);
        p.y = d[2] | (d[3] << 8);
      }
      gtWrite(0x814E, 0);  // clear status
    }
  } else if (touchCtl == TOUCH_FT6X36) {
    uint8_t d[7];
    if (!ftRead(0x02, d, 7)) return p;
    uint8_t n = d[0] & 0x0F;
    if (n > 0 && n < 3) {
      p.pressed = true;
      p.x = ((d[1] & 0x0F) << 8) | d[2];
      p.y = ((d[3] & 0x0F) << 8) | d[4];
    }
  }
  return p;
}
inline void touchSleep() {
  if (touchCtl == TOUCH_GT911) gtWrite(0x8040, 0x05);  // sleep command
}

#else
inline const char* touchBegin() { return nullptr; }
inline TouchPoint touchRead() { return TouchPoint(); }
inline void touchSleep() {}
#endif
