# orbis e-ink firmware

one codebase for the common e-paper boards. the board fetches a ready-made bitmap from your hub every few minutes, shows it and sleeps. all the layout work happens on the hub, the esp only needs wifi and a display driver.

## boards

| env | board | panel | grays | touch | notes |
| --- | --- | --- | --- | --- | --- |
| `inkplate6` | soldered inkplate 6 (v2) | 800×600 | 8 | – | battery sense built in |
| `inkplate6plus` | inkplate 6PLUS | 1024×758 | 8 | yes (library) | |
| `inkplate10` | inkplate 10 | 1200×825 | 8 | – | |
| `inkplate6color` | inkplate 6COLOR | 600×448 | b/w mode | – | color mode later |
| `lilygo-t5-47` | lilygo t5 4.7" (esp32 wrover) | 960×540 | 16 | – | |
| `lilygo-t5-47-s3` | lilygo t5 4.7" s3 / plus | 960×540 | 16 | auto (gt911 / ft6x36) | i2c sda 18 scl 17 |
| `waveshare-75` | waveshare esp32 e-paper driver board + 7.5" b/w | 800×480 | 1 | – | gxepd2 `GxEPD2_750_T7` |
| `waveshare-42` | same board + 4.2" | 400×300 | 1 | – | |
| `waveshare-29` | same board + 2.9" | 296×128 | 1 | – | |

other panels on the waveshare driver board: copy a `waveshare-*` env and change `ORBIS_GX_CLASS` to the matching gxepd2 class and the size. other esp32 boards with an i2c touch overlay: add `-DORBIS_TOUCH_I2C -DORBIS_SDA=<pin> -DORBIS_SCL=<pin>`; the controller (gt911 or ft6x36) is detected at boot.

## flash

easiest: the [web flasher](https://orbis-hub.github.io/flash/) (chrome/edge, usb). pick your board, click install.

by hand with platformio:

```bash
pio run -e waveshare-75 -t upload
pio device monitor
```

## first start

the board opens a wifi network **orbis-eink**. connect to it, a portal opens (or go to 192.168.4.1): choose your wifi, enter the hub url (`http://192.168.1.20:3001`), the display id and the token from orbis → e-ink → *token & setup*. done. the display shows the dashboard within a minute.

hold the **BOOT** button while powering on to reopen the portal (new wifi, new hub).

## how it talks to the hub

`GET <hub>/api/eink/<id>.bin` with `Authorization: Bearer <token>` and headers `X-Orbis-Board`, `X-Orbis-Firmware`, `X-Orbis-Battery`, `X-Orbis-Touch`. the answer is an **ORB1** frame:

```
"ORB1" | u16 width | u16 height | u8 bits (1/2/4/8) | u8 flags | u16 refreshMinutes | u32 crc32 | packed rows, msb first, 0 = black
```

the firmware keeps the last crc in rtc memory and skips the redraw when nothing changed (e-paper refreshes are slow and flashy). `refreshMinutes` comes from the display settings in orbis, so you change the interval on the hub, not on the device.

touch boards stay awake for 20 s after a refresh and `POST <hub>/api/eink/<id>/tap { x, y }`; when the hub answers `refresh: true` the frame is fetched again.

## power

deep sleep between refreshes; a 7.5" waveshare with a 2000 mAh cell and a 10 minute interval lasts weeks, inkplate and lilygo with their own battery management longer. battery percentage is reported to the hub and shown on the e-ink page.

## building the release binaries

`.github/workflows/firmware.yml` builds every env on a `fw-v*` tag and attaches `orbis-<env>.bin` (merged, flashable at 0x0) to the release; the web flasher reads them from there.
