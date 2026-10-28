// MemoLight - environmental memory and replay lamp (Arduino UNO)
//
// Wiring: LED R=11 G=9 B=10 | DHT11=2 | LDR=A0 (voltage divider)
//         SD (software SPI): CS=4 SCK=5 MISO=6 MOSI=7
// SD files: NEW.CSV (recording), READY.CSV (verified, waiting),
//           MEMORY.CSV (replayed at night), OLD.CSV (temporary during swap)
// Serial: 9600 baud. DATA line is read by the dashboard; do not change its format.

#include <DHT.h>
#include "SdFat.h"
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

#define DHTPIN 2
#define DHTTYPE DHT11

const int RED_PIN = 11;
const int GREEN_PIN = 9;
const int BLUE_PIN = 10;
const int LDR_PIN = A0;

const uint8_t SOFT_MOSI_PIN = 7;
const uint8_t SOFT_MISO_PIN = 6;
const uint8_t SOFT_SCK_PIN = 5;
const uint8_t SD_CS_PIN = 4;

SoftSpiDriver<SOFT_MISO_PIN, SOFT_MOSI_PIN, SOFT_SCK_PIN> softSpi;
#define SD_CONFIG SdSpiConfig(SD_CS_PIN, DEDICATED_SPI, SD_SCK_MHZ(0), &softSpi)

SdFat32 sd;
File32 recFile;
File32 playFile;

DHT dht(DHTPIN, DHTTYPE);

float rScale = 1.00;
float gScale = 1.00;
float bScale = 1.00;

// true = reading is flipped so covering the LDR gives a LOWER number.
// Depends on the voltage-divider wiring.
const bool LDR_INVERT = false;

// Day/night thresholds on the LDR value (bright = high).
const int NIGHT_BELOW = 190;
const int DAY_ABOVE = 215;
// true  = switch after 5 s, save with 5 rows (demo)
// false = switch after 10 min, save with 150 rows (real use)
bool demoMode = true;
bool autoMode = true;

bool verbose = true;

const float TEMP_MIN = 26.0;
const float TEMP_MAX = 34.0;
const float HUM_MIN = 40.0;
const float HUM_MAX = 90.0;
const float HUM_SHIFT = 3.0;
const float LIGHT_SHIFT = 3.0;

const float BRIGHT_DARKROOM = 1.00;
const float BRIGHT_BRIGHTROOM = 1.00;
const float BOOST = 2.0;
const float PEAK_MIN = 255;
const float EASE = 0.03;

// The brightness slider never goes below this, so it cannot switch the lamp off.
const float MIN_BRIGHT = 0.05;

struct ColorPreset {
  char name[22];
  uint8_t r, g, b;
};

// Same order as the PALETTE list in the dashboard's app.js (dark -> light).
const ColorPreset palette[] PROGMEM = {
 {"Chestnut Plum",         133,   8,    3},
  {"Brown Red",             200,  15,   2},
  {"Kara Cha Brown",        180,  20,   5},
  {"Mummy Brown",           160,  18,   4},
  {"Crimson Blaze",         255,  4,    0},
  {"Brandy Bear",           150,  16,   2},
  {"Mid Century Furniture", 230,  28,   2}, 
  {"Rusty Nail",            215,  18,   1}, 
  {"Splinter",              190,  42,   4}, 
  {"Cinnamon",              255,  38,   0},
  {"Acorn Spice",           220,  55,   3}, 
  {"Maine Coon Orange",     200,  50,   2}, 
  {"Basketball",            245,  32,   0}, 
  {"French Toast",          235,  58,   2}, 
  {"Carrot Orange",         245,  78,   1}, 
  {"White",                 255, 140,   125}
};

const int NUM_COLORS = sizeof(palette) / sizeof(palette[0]);

// Auto mode stops at Carrot Orange; White is manual only (C15 / K15 / dashboard).
const int AUTO_MAX = NUM_COLORS - 2;

// PWM {R, G, B} actually sent to the LED for each shade.
uint8_t pwm[NUM_COLORS][3] = {
  { 69,  6,  1},  // 0  Chestnut Plum
  { 84,  5,  0},  // 1  Brown Red
  { 62,  9,  1},  // 2  Kara Cha Brown
  { 65, 12,  2},  // 3  Mummy Brown
  {107, 10,  1},  // 4  Crimson Blaze
  {116, 17,  1},  // 5  Brandy Bear
  {123, 19,  1},  // 6  Mid Century Furniture
  {158, 16,  2},  // 7  Rusty Nail
  {103, 31,  6},  // 8  Splinter
  {173, 28,  0},  // 9  Cinnamon
  {127, 33,  5},  // 10 Acorn Spice
  {152, 35,  3},  // 11 Maine Coon Orange
  {222, 26,  3},  // 12 Basketball
  {197, 42,  2},  // 13 French Toast
  {218, 47,  1},  // 14 Carrot Orange
  {255,100, 40}   // 15 White
};

int forceIdx = -1;
bool forceTimed = false;

float sTemp = 28;
float sHum = 60;
float sLdr = 0;          // set from a real reading in setup()

float ldrLo = 0;         // adaptive range, set around the first reading in setup()
float ldrHi = 1023;

bool dhtReady = false;
bool lampOn = true;
float userBright = 1.0;

bool replayActive = false;
float rpTemp = 28;
float rpHum = 60;
float rpLdr = 0;
unsigned long lastPlayMs = 0;

int rpIdx = -1;
int rpPctDirect = 50;

float dispR = 0;
float dispG = 0;
float dispB = 0;
float dispBright = 0;

unsigned long lastDhtMs = 0;

bool sdOk = false;
bool sdRec = false;
bool sdRecEnabled = true;   // false after R0; day/night logic keeps running
bool playing = false;

unsigned long recRows = 0;

// Values read back from MEMORY.CSV during night replay
float mTemp = 0;
float mHum = 0;
int mPct = 50;
int mIdx = 0;
int mLdr = -1;   // raw LDR recorded at that moment (-1 = old file without it)

char phase = 'U';

unsigned long darkSince = 0;
unsigned long brightSince = 0;

const char HEADER_P[] PROGMEM = "temp_c,humidity_pct,light_pct,color_no,color,ldr_raw";

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

float fmap(float x, float inMin, float inMax,
           float outMin, float outMax) {
  if (inMax == inMin) return outMin;

  x = constrain(x, inMin, inMax);

  return outMin + (x - inMin) *
         (outMax - outMin) / (inMax - inMin);
}

// Widens the range at once, then lets it relax slowly. Keeps a minimum span.
void trackLdrRange(float v) {
  if (v < ldrLo) ldrLo = v;
  if (v > ldrHi) ldrHi = v;

  ldrLo += (v - ldrLo) * 0.00002;
  ldrHi += (v - ldrHi) * 0.00002;

  if (ldrHi - ldrLo < 120) {
    float mid = (ldrHi + ldrLo) / 2;
    ldrLo = mid - 60;
    ldrHi = mid + 60;
  }
}

// Smoothed LDR mapped to 0.0 - 1.0 against the adaptive range.
float lightNorm(float l) {
  return fmap(l, ldrLo, ldrHi, 0, 1);
}

float positionFor(float t, float h, float l) {
  float p = fmap(t, TEMP_MIN, TEMP_MAX, 0, AUTO_MAX);

  p -= fmap(h, HUM_MIN, HUM_MAX, -HUM_SHIFT, HUM_SHIFT);
  p += (lightNorm(l) - 0.5) * 2.0 * LIGHT_SHIFT;

  return constrain(p, 0, AUTO_MAX);
}

float brightnessForPct(float pct) {
  return BRIGHT_DARKROOM +
         (BRIGHT_BRIGHTROOM - BRIGHT_DARKROOM) *
         (pct / 100.0);
}

int nearestIndex(float pos) {
  return constrain((int)(pos + 0.5), 0, NUM_COLORS - 1);
}

void getColor(int i, ColorPreset &c) {
  i = constrain(i, 0, NUM_COLORS - 1);
  memcpy_P(&c, &palette[i], sizeof(c));
}

int nearestByRgb(int r, int g, int b) {
  int best = 0;
  long bestD = 2000000000L;
  ColorPreset c;

  for (int i = 0; i < NUM_COLORS; i++) {
    getColor(i, c);

    long dr = (long)c.r - r;
    long dg = (long)c.g - g;
    long db = (long)c.b - b;

    long d = dr * dr + dg * dg + db * db;

    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }

  return best;
}

// Cuts every LED channel at once and resets the fade values.
void lampOffNow() {
  dispR = 0;
  dispG = 0;
  dispB = 0;
  dispBright = 0;

  analogWrite(RED_PIN, 0);
  analogWrite(GREEN_PIN, 0);
  analogWrite(BLUE_PIN, 0);

  digitalWrite(RED_PIN, LOW);
  digitalWrite(GREEN_PIN, LOW);
  digitalWrite(BLUE_PIN, LOW);
}

// Sends the PWM values of shade idx to the LED, eased smoothly.
void updateLamp(int idx, float bright) {
  idx = constrain(idx, 0, NUM_COLORS - 1);

  if (!lampOn || bright <= 0.001) {
    lampOffNow();
    return;
  }

  dispR += (pwm[idx][0] - dispR) * EASE;
  dispG += (pwm[idx][1] - dispG) * EASE;
  dispB += (pwm[idx][2] - dispB) * EASE;
  dispBright += (bright - dispBright) * EASE;

  float r = dispR * rScale;
  float g = dispG * gScale;
  float b = dispB * bScale;

  // Raise the strongest channel to PEAK_MIN (never past 255), keeping the hue.
  float m = max(r, max(g, b));
  float k = BOOST;
  if (m > 0) {
    float need = PEAK_MIN / m;
    if (need > k) k = need;
    if (m * k > 255.0) k = 255.0 / m;
  }

  analogWrite(RED_PIN,   constrain((int)(r * k * dispBright + 0.5), 0, 255));
  analogWrite(GREEN_PIN, constrain((int)(g * k * dispBright + 0.5), 0, 255));
  analogWrite(BLUE_PIN,  constrain((int)(b * k * dispBright + 0.5), 0, 255));
}

// Reads a whole number from serial. Returns false if no digits arrived, so a
// lost digit can never become 0 (first color / lamp off).
bool readIntSafe(int &out) {
  unsigned long t0 = millis();
  long v = 0;
  bool neg = false;
  bool got = false;

  while (millis() - t0 < 150) {
    if (!Serial.available()) continue;

    char ch = (char)Serial.peek();

    if (ch == '-' && !got) {
      neg = true;
      Serial.read();
    } else if (ch >= '0' && ch <= '9') {
      v = v * 10 + (ch - '0');
      got = true;
      Serial.read();
      t0 = millis();
    } else if (got) {
      break;
    } else {
      Serial.read();
    }
  }

  if (!got) return false;

  out = neg ? -(int)v : (int)v;
  return true;
}

// --------------------------------------------------
// SENSORS
// --------------------------------------------------

// Real LDR value: average of 8 readings (2 ms apart), 0-1023, flipped if LDR_INVERT.
int readLdrRaw() {
  long sum = 0;

  for (int i = 0; i < 8; i++) {
    sum += analogRead(LDR_PIN);
    delay(2);
  }

  int v = constrain((int)(sum / 8), 0, 1023);
  return LDR_INVERT ? 1023 - v : v;
}

void readDht() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (isnan(t) || isnan(h)) {
    Serial.println(F("DHT read failed - check wiring"));
    return;
  }

  if (!dhtReady) {
    sTemp = t;
    sHum = h;
    dhtReady = true;
  } else {
    sTemp += (t - sTemp) * 0.3;
    sHum += (h - sHum) * 0.3;
  }
}

// Dashboard line. Keep this format exactly as it is.
void sendDataLine(float t, float h, int ldr, int idx, int pct) {
  ColorPreset c;
  getColor(idx, c);

  int r = lampOn ? c.r : 0;
  int g = lampOn ? c.g : 0;
  int b = lampOn ? c.b : 0;

  Serial.print(F("DATA,"));
  Serial.print(t, 1);
  Serial.print(',');
  Serial.print(h, 1);
  Serial.print(',');
  Serial.print(ldr);
  Serial.print(',');
  Serial.print(r);
  Serial.print(',');
  Serial.print(g);
  Serial.print(',');
  Serial.print(b);
  Serial.print(',');
  Serial.print(lampOn ? c.name : "LAMP OFF");
  Serial.print(',');
  Serial.println(pct);
}

// Always shows the LIVE sensor values, even while replaying the saved memory.
void printLiveLine(const __FlashStringHelper* src, int idx) {
  ColorPreset c;
  getColor(idx, c);

  Serial.print(F("LIVE  Temp="));
  Serial.print(sTemp, 1);
  Serial.print(F("C  Hum="));
  Serial.print(sHum, 1);
  Serial.print(F("%  LDR="));
  Serial.print((int)sLdr);
  Serial.print(F(" ("));
  Serial.print((int)(lightNorm(sLdr) * 100));
  Serial.print(F("%)  Phase="));
  Serial.print(phase);
  Serial.print(F("  Lamp="));
  Serial.print(lampOn ? c.name : "OFF");
  Serial.print(F("  Source="));
  Serial.print(src);
  Serial.print(F("  SD="));
  Serial.print(sdOk ? F("ok") : F("none"));
  if (!sdRecEnabled) Serial.print(F("  AUTO-REC OFF"));
  if (sdRec) {
    Serial.print(F("  REC rows="));
    Serial.print(recRows);
  }
  Serial.println();
}

void printSettings() {
  Serial.print(F("STATUS LDR="));
  Serial.print((int)sLdr);
  Serial.print(F(" lamp="));
  Serial.print(lampOn);
  Serial.print(F(" auto="));
  Serial.print(autoMode);
  Serial.print(F(" demo="));
  Serial.print(demoMode);
  Serial.print(F(" phase="));
  Serial.print(phase);
  Serial.print(F(" sd="));
  Serial.print(sdOk);
  Serial.print(F(" rec="));
  Serial.print(sdRec);
  Serial.print(F(" recEnabled="));
  Serial.print(sdRecEnabled);
  Serial.print(F(" play="));
  Serial.print(playing);
  Serial.print(F(" shade="));
  Serial.print(forceIdx);
  if (forceIdx >= 0) {
    Serial.print(F(" pwm="));
    Serial.print(pwm[forceIdx][0]);
    Serial.print(',');
    Serial.print(pwm[forceIdx][1]);
    Serial.print(',');
    Serial.print(pwm[forceIdx][2]);
  }
  Serial.print(F(" trims R="));
  Serial.print((int)(rScale * 100 + 0.5));
  Serial.print(F(" G="));
  Serial.print((int)(gScale * 100 + 0.5));
  Serial.print(F(" B="));
  Serial.println((int)(bScale * 100 + 0.5));
}

// --------------------------------------------------
// SD MEMORY (SdFat, software SPI)
// --------------------------------------------------

int readLine(File32 &f, char* buf, int cap) {
  int n = 0;
  bool got = false;

  while (f.available()) {
    int c = f.read();
    got = true;

    if (c == '\n') break;
    if (c == '\r') continue;

    if (n < cap - 1) buf[n++] = (char)c;
  }

  buf[n] = 0;
  return got ? n : -1;
}

float num(char*& p) {
  float v = atof(p);
  char* c = strchr(p, ',');

  p = c ? c + 1 : p + strlen(p);
  return v;
}

// Row format: temp_c,humidity_pct,light_pct,color_no,color,ldr_raw
// Number-to-text helpers are used instead of printf-style formatting,
// which would add about 2 KB of flash.
static char* putLong(char* p, long v) {
  ltoa(v, p, 10);
  return p + strlen(p);
}

static char* putTenths(char* p, float x) {
  long v = (long)(x * 10.0 + (x < 0 ? -0.5 : 0.5));
  if (v < 0) { *p++ = '-'; v = -v; }
  p = putLong(p, v / 10);
  *p++ = '.';
  *p++ = (char)('0' + (v % 10));
  return p;
}

// Each row is written in one piece. If a write fails, recording stops and
// NEW.CSV is never promoted to MEMORY.CSV.
void logRow(float t, float h, int pct, int idx, int ldr) {
  ColorPreset c;
  getColor(idx, c);

  char row[80];
  char* p = row;

  p = putTenths(p, t);   *p++ = ',';
  p = putTenths(p, h);   *p++ = ',';
  p = putLong(p, pct);   *p++ = ',';
  p = putLong(p, idx);   *p++ = ',';
  strcpy(p, c.name);     p += strlen(p);
  *p++ = ',';
  p = putLong(p, ldr);
  *p++ = '\r';
  *p++ = '\n';

  size_t len = (size_t)(p - row);

  bool ok = (recFile.write((const uint8_t*)row, len) == len) && recFile.sync();

  if (ok) {
    recRows++;
  } else {
    recFile.close();
    sdRec = false;
    Serial.println(F("MEMORY,RECORD_WRITE_FAILED"));
  }
}

void startRec() {
  if (!sdOk || sdRec || !sdRecEnabled) return;

  sd.remove("NEW.CSV");

  if (!recFile.open("NEW.CSV", O_WRONLY | O_CREAT | O_TRUNC)) {
    Serial.println(F("MEMORY,RECORD_OPEN_FAILED"));
    return;
  }

  recFile.println((const __FlashStringHelper*)HEADER_P);
  recFile.sync();

  sdRec = true;
  recRows = 0;

  Serial.println(F("MODE,RECORDING"));
}

// Header correct, every row has 6 fields, row count matches rows written.
bool recordingValid() {
  File32 f;
  if (!f.open("NEW.CSV", O_RDONLY)) return false;

  char line[64];
  bool ok = (readLine(f, line, sizeof(line)) > 0) &&
            (strcmp_P(line, HEADER_P) == 0);

  unsigned long rows = 0;
  int n;

  while (ok && (n = readLine(f, line, sizeof(line))) >= 0) {
    if (n == 0) continue;

    int commas = 0;
    for (int i = 0; i < n; i++) {
      if (line[i] == ',') commas++;
    }

    if (commas != 5) ok = false;
    rows++;
  }

  f.close();
  return ok && rows == recRows;
}

// READY.CSV becomes MEMORY.CSV. The old memory moves to OLD.CSV first and is
// restored if anything fails.
bool finishPromote() {
  if (!sd.exists("READY.CSV")) return false;

  if (sd.exists("MEMORY.CSV")) sd.remove("OLD.CSV");

  bool hadOld = sd.exists("MEMORY.CSV");

  if (hadOld && !sd.rename("MEMORY.CSV", "OLD.CSV")) return false;

  if (!sd.rename("READY.CSV", "MEMORY.CSV")) {
    if (hadOld) sd.rename("OLD.CSV", "MEMORY.CSV");
    return false;
  }

  sd.remove("OLD.CSV");
  return true;
}

void promote() {
  sd.remove("READY.CSV");

  if (!sd.rename("NEW.CSV", "READY.CSV")) {
    Serial.println(F("MEMORY,SAVE_FAILED"));
    return;
  }

  if (finishPromote()) {
    Serial.println(F("MEMORY,SAVED"));
  } else {
    Serial.println(F("MEMORY,SAVE_FAILED"));
  }
}

// Finishes or undoes a memory swap interrupted by a power cut.
void recoverMemory() {
  if (!sd.exists("MEMORY.CSV") && sd.exists("OLD.CSV")) {
    sd.rename("OLD.CSV", "MEMORY.CSV");
  }

  if (sd.exists("READY.CSV")) finishPromote();

  if (sd.exists("MEMORY.CSV")) sd.remove("OLD.CSV");
}

void stopRec() {
  if (!sdRec) return;

  recFile.close();
  sdRec = false;

  if (recRows < (demoMode ? 5UL : 150UL)) {
    Serial.println(F("MEMORY,TOO_SHORT_NOT_SAVED"));
    return;
  }

  if (!recordingValid()) {
    Serial.println(F("MEMORY,SAVE_FAILED"));
    return;
  }

  promote();
}

bool nextMemoryRow() {
  char line[64];

  int n = readLine(playFile, line, sizeof(line));

  if (n < 0) {
    playFile.seekSet(0);
    readLine(playFile, line, sizeof(line));
    n = readLine(playFile, line, sizeof(line));
  }

  if (n <= 0) return false;

  char* p = line;

  mTemp = num(p);
  mHum = num(p);
  mPct = constrain((int)num(p), 0, 100);
  mIdx = constrain((int)num(p), 0, NUM_COLORS - 1);

  char* c = strchr(p, ',');
  mLdr = c ? atoi(c + 1) : -1;

  return true;
}

bool startPlay() {
  if (!sdOk || !sd.exists("MEMORY.CSV")) return false;

  if (!playFile.open("MEMORY.CSV", O_RDONLY)) return false;

  char line[64];
  readLine(playFile, line, sizeof(line));

  playing = nextMemoryRow();

  if (!playing) playFile.close();

  return playing;
}

void stopPlay() {
  if (playing) {
    playFile.close();
    playing = false;
  }
}

void enterDay() {
  phase = 'D';
  stopPlay();
  startRec();
}

void enterNight() {
  phase = 'N';
  stopRec();

  if (startPlay()) {
    Serial.println(F("MODE,REPLAYING_MEMORY"));
  } else {
    Serial.println(F("MODE,NIGHT_BUT_NO_MEMORY_YET"));
  }
}

// Switches phase only after the light has stayed beyond a threshold for the
// whole dwell time. Values between the thresholds reset the timers.
void autoDayNight(unsigned long now) {
  if (!autoMode || replayActive || forceIdx >= 0) {
    darkSince = brightSince = 0;
    return;
  }

  int v = (int)sLdr;
  unsigned long dwell = demoMode ? 5000UL : 600000UL;

  if (v < NIGHT_BELOW) {
    brightSince = 0;
    if (!darkSince) darkSince = now;
  } else if (v > DAY_ABOVE) {
    darkSince = 0;
    if (!brightSince) brightSince = now;
  } else {
    darkSince = brightSince = 0;
  }

  if (darkSince && now - darkSince >= dwell && phase != 'N') {
    enterNight();
  }

  if (brightSince && now - brightSince >= dwell && phase != 'D') {
    enterDay();
  }
}

// --------------------------------------------------
// SERIAL COMMANDS (one letter/digit, usually followed by a number)
// --------------------------------------------------
// 1 / 0      lamp on / off
// B<0-100>   brightness (never below MIN_BRIGHT)
// N / U      stop / resume night memory replay
// S          SD status          R0 / R1  automatic SD recording off / on
// F / O / D  list / download / delete saved memory
// X          end a dashboard test and return to the live room
// C<0-15>    show that palette color (held while repeated)
// T<temp>,<hum>,<light%>  and  P<temp>,<hum>,<ldr>  test values
// H<temp>,<hum>,<ldr>,<r>,<g>,<b>,<light%>  replay a recorded reading
// K<n> / K-1 show shade steadily / normal;  M<r> <g> <b> set its PWM
// Y / G / L<0-100>  red / green / blue trim (percent)
// Q status   A0/A1 auto mode   V0/V1 demo timing   W erase memory
// I0 / I1    hide / show the LIVE line

void handleSerial() {
  // A 0 or 1 right after another digit belongs to a number (e.g. the 0 in "50"),
  // not to the lamp off / on command.
  static bool lastWasDigit = false;

  while (Serial.available()) {
    char raw = (char)Serial.read();
    bool isDigit = (raw >= '0' && raw <= '9');

    if (isDigit && lastWasDigit) {
      continue;
    }

    lastWasDigit = isDigit;

    char c = toupper(raw);

    if (c == '1') {
      lampOn = true;
      Serial.println(F("LAMP,ON"));
    }
    else if (c == '0') {
      lampOn = false;
      lampOffNow();
      Serial.println(F("LAMP,OFF"));
    }
    else if (c == 'X') {
      replayActive = false;
      rpIdx = -1;
      forceIdx = -1;
      forceTimed = false;
    }
    else if (c == 'B') {
      int n;

      if (readIntSafe(n)) {
        userBright = constrain(n, 0, 100) / 100.0;
        if (userBright < MIN_BRIGHT) userBright = MIN_BRIGHT;

        Serial.print(F("BRIGHT,"));
        Serial.println((int)(userBright * 100 + 0.5));
      }
    }
    else if (c == 'P' || c == 'T') {
      rpTemp = Serial.parseFloat();
      rpHum = Serial.parseFloat();

      float v = Serial.parseFloat();

      rpLdr = (c == 'T')
        ? ldrLo + (constrain(v, 0, 100) / 100.0) * (ldrHi - ldrLo)
        : v;

      rpIdx = -1;
      forceIdx = -1;
      forceTimed = false;

      replayActive = true;
      lastPlayMs = millis();

      sendDataLine(
        rpTemp,
        rpHum,
        (int)rpLdr,
        nearestIndex(positionFor(rpTemp, rpHum, rpLdr)),
        (int)(lightNorm(rpLdr) * 100)
      );
    }
    else if (c == 'H') {
      rpTemp = Serial.parseFloat();
      rpHum = Serial.parseFloat();
      rpLdr = Serial.parseFloat();

      int r = Serial.parseInt();
      int g = Serial.parseInt();
      int b = Serial.parseInt();

      rpPctDirect = constrain(Serial.parseInt(), 0, 100);

      rpIdx = (r + g + b > 0)
        ? nearestByRgb(r, g, b)
        : -1;

      forceIdx = -1;
      forceTimed = false;
      replayActive = true;
      lastPlayMs = millis();

      int shown = (rpIdx >= 0)
        ? rpIdx
        : nearestIndex(positionFor(rpTemp, rpHum, rpLdr));

      sendDataLine(rpTemp, rpHum, (int)rpLdr, shown, rpPctDirect);
    }
    else if (c == 'C') {
      int n;

      if (readIntSafe(n)) {
        forceIdx = constrain(n, 0, NUM_COLORS - 1);
        forceTimed = true;
        replayActive = false;
        rpIdx = -1;
        lastPlayMs = millis();

        Serial.print(F("FORCE,"));
        Serial.println(forceIdx);

        sendDataLine(
          sTemp, sHum, (int)sLdr,
          forceIdx, (int)(lightNorm(sLdr) * 100)
        );
      } else {
        Serial.println(F("FORCE,NO_NUMBER"));
      }
    }
    else if (c == 'N') {
      // phase stays 'N', so replay does not restart until the next day-to-night switch.
      if (playing) {
        stopPlay();
        Serial.println(F("MODE,LIVE"));
      } else {
        Serial.println(F("MODE,NOPLAY"));
      }
    }
    else if (c == 'U') {
      if (phase == 'N' && !playing) {
        if (startPlay()) {
          Serial.println(F("MODE,REPLAYING_MEMORY"));
        } else {
          Serial.println(F("MODE,NIGHT_BUT_NO_MEMORY_YET"));
        }
      } else {
        Serial.println(F("MODE,NOPLAY"));
      }
    }
    else if (c == 'S') {
      Serial.println(sdOk ? F("SDSTAT,OK") : F("SDSTAT,NOCARD"));
      Serial.println(sdRecEnabled ? F("SDREC,ON") : F("SDREC,OFF"));
    }
    else if (c == 'R') {
      // Only SD recording changes; day/night detection, colors and replay keep running.
      int n;
      if (readIntSafe(n)) {
        if (n == 0) {
          sdRecEnabled = false;
          if (sdRec) {
            // Discard the unfinished recording; MEMORY.CSV stays untouched.
            recFile.close();
            sdRec = false;
            sd.remove("NEW.CSV");
            Serial.println(F("MEMORY,REC_DISCARDED"));
          }
          Serial.println(F("SDREC,OFF"));
        } else {
          sdRecEnabled = true;
          Serial.println(F("SDREC,ON"));
          if (autoMode && phase == 'D') startRec();
        }
      }
    }
    else if (c == 'F') {
      Serial.println(F("SDLIST,BEGIN"));
      File32 f;
      if (sdOk && f.open("MEMORY.CSV", O_RDONLY)) {
        Serial.print(F("SDITEM,1,"));
        Serial.println(f.fileSize());
        f.close();
      }
      Serial.println(F("SDLIST,END"));
    }
    else if (c == 'O') {
      // First column = approximate seconds (row x 2 s); there is no real clock.
      // The lamp does not update while this runs.
      File32 f;
      if (!sdOk) {
        Serial.println(F("SDDL,ERR,NOCARD"));
      } else if (sdRec) {
        Serial.println(F("SDDL,ERR,BUSY"));
      } else if (!f.open("MEMORY.CSV", O_RDONLY)) {
        Serial.println(F("SDDL,ERR,NOFILE"));
      } else {
        char line[64];
        readLine(f, line, sizeof(line));
        long row = 0;
        while (row < 3600 && readLine(f, line, sizeof(line)) > 0) {
          char* p = line;
          float t = num(p);
          float h = num(p);
          int pct = constrain((int)num(p), 0, 100);
          int idx = constrain((int)num(p), 0, NUM_COLORS - 1);
          char* comma = strchr(p, ',');
          int ldr = comma ? atoi(comma + 1) : 0;

          ColorPreset cp;
          getColor(idx, cp);

          Serial.print(F("SDROW,"));
          Serial.print(row * 2);
          Serial.print(',');
          Serial.print(t, 1);
          Serial.print(',');
          Serial.print(h, 1);
          Serial.print(',');
          Serial.print(ldr);
          Serial.print(',');
          Serial.print(cp.r);
          Serial.print(',');
          Serial.print(cp.g);
          Serial.print(',');
          Serial.print(cp.b);
          Serial.print(',');
          Serial.print(cp.name);
          Serial.print(',');
          Serial.println(pct);
          row++;
        }
        f.close();
        Serial.println(F("SDDL,END"));
      }
    }
    else if (c == 'D') {
      if (sdOk && !sdRec && !playing && sd.remove("MEMORY.CSV")) {
        Serial.println(F("SDDEL,OK,1"));
      } else {
        Serial.println(F("SDDEL,ERR"));
      }
    }
    else if (c == 'I') {
      int n;
      if (readIntSafe(n)) {
        verbose = (n != 0);
        Serial.println(verbose ? F("LIVE line ON") : F("LIVE line OFF"));
      }
    }
    else if (c == 'A') {
      int n;

      if (readIntSafe(n)) {
        autoMode = (n != 0);

        if (!autoMode) {
          stopRec();
          stopPlay();
          phase = 'U';
          darkSince = brightSince = 0;
        }
      }

      printSettings();
    }
    else if (c == 'V') {
      int n;
      if (readIntSafe(n)) demoMode = (n != 0);
      printSettings();
    }
    else if (c == 'W') {
      if (sdRec) {
        recFile.close();
        sdRec = false;
      }

      stopPlay();

      if (sdOk) {
        sd.remove("NEW.CSV");
        sd.remove("READY.CSV");
        sd.remove("OLD.CSV");
        sd.remove("MEMORY.CSV");
      }

      phase = 'U';
      Serial.println(F("MEMORY,ERASED"));
    }
    else if (c == 'Q') {
      printSettings();
    }
    else if (c == 'K') {
      int n;

      if (readIntSafe(n)) {
        forceIdx = (n < 0)
          ? -1
          : min(n, NUM_COLORS - 1);

        forceTimed = false;
      }

      printSettings();
    }
    else if (c == 'M') {
      int r = Serial.parseInt();
      int g = Serial.parseInt();
      int b = Serial.parseInt();

      if (forceIdx >= 0) {
        pwm[forceIdx][0] = constrain(r, 0, 255);
        pwm[forceIdx][1] = constrain(g, 0, 255);
        pwm[forceIdx][2] = constrain(b, 0, 255);
      } else {
        Serial.println(F("Send K<number> first, e.g. K12"));
      }

      printSettings();
    }
    else if (c == 'Y') {
      int n;
      if (readIntSafe(n)) rScale = constrain(n, 0, 100) / 100.0;
      printSettings();
    }
    else if (c == 'G') {
      int n;
      if (readIntSafe(n)) gScale = constrain(n, 0, 100) / 100.0;
      printSettings();
    }
    else if (c == 'L') {
      int n;
      if (readIntSafe(n)) bScale = constrain(n, 0, 100) / 100.0;
      printSettings();
    }
  }
}

// --------------------------------------------------
// SETUP
// --------------------------------------------------

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);

  lampOffNow();

  Serial.begin(9600);
  Serial.setTimeout(50);

  dht.begin();

  Serial.println(F("MemoLight started."));

  sdOk = sd.begin(SD_CONFIG);

  Serial.println(
    sdOk ? F("SD ready.") : F("SD not found - memory is off.")
  );

  if (sdOk) recoverMemory();

  delay(1500);

  readDht();

  sLdr = readLdrRaw();

  ldrLo = max(0.0, sLdr - 100.0);
  ldrHi = min(1023.0, sLdr + 100.0);

  Serial.println(F("READY"));
}

// --------------------------------------------------
// MAIN LOOP
// --------------------------------------------------

void loop() {
  unsigned long now = millis();

  sLdr += (readLdrRaw() - sLdr) * 0.25;
  trackLdrRange(sLdr);

  bool due = (now - lastDhtMs >= 2000);

  if (due) {
    lastDhtMs = now;

    readDht();

    if (playing && !replayActive && forceIdx < 0) {
      if (!nextMemoryRow()) stopPlay();
    }
  }

  if (replayActive && now - lastPlayMs > 10000) {
    replayActive = false;
    rpIdx = -1;
  }

  if (forceTimed && now - lastPlayMs > 10000) {
    forceIdx = -1;
    forceTimed = false;
  }

  autoDayNight(now);

  float t = replayActive ? rpTemp : sTemp;
  float h = replayActive ? rpHum : sHum;
  float l = replayActive ? rpLdr : sLdr;

  int pct = (int)(lightNorm(l) * 100);
  int idx;
  float bright;
  const __FlashStringHelper* src = F("LIVE");

  if (forceIdx >= 0) {
    idx = forceIdx;
    bright = userBright;
    src = F("FORCED");
  }
  else if (replayActive && rpIdx >= 0) {
    idx = rpIdx;
    pct = rpPctDirect;
    bright = brightnessForPct(rpPctDirect) * userBright;
    src = F("TEST");
  }
  else if (playing && !replayActive) {
    // Night replay: use everything that was recorded.
    t = mTemp;
    h = mHum;
    pct = mPct;
    idx = mIdx;
    if (mLdr >= 0) l = mLdr;
    bright = brightnessForPct(mPct) * userBright;
    src = F("MEMORY");
  }
  else {
    idx = nearestIndex(positionFor(t, h, l));
    bright = constrain(brightnessForPct(pct), 0, 1) * userBright;
    if (replayActive) src = F("TEST");
  }

  updateLamp(idx, lampOn ? bright : 0);

  if (due) {
    if (verbose) printLiveLine(src, idx);

    sendDataLine(t, h, (int)l, idx, pct);

    if (sdRec && !replayActive && forceIdx < 0) {
      logRow(t, h, pct, idx, (int)l);
    }
  }

  handleSerial();
  delay(10);
}