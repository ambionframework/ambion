// The kit firmware: blink the LED and read the HC-SR04 once a second.
// Set each pin from pins.md before you build.

const int LED_PIN = -1;   // TBD
const int TRIG_PIN = -1;  // TBD
const int ECHO_PIN = -1;  // TBD

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long echo = pulseIn(ECHO_PIN, HIGH);
  Serial.println(echo / 58.0);  // centimetres
  digitalWrite(LED_PIN, HIGH);
  delay(500);
  digitalWrite(LED_PIN, LOW);
  delay(500);
}
