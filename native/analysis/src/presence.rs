//! Whether sound is really there: the level against a learned noise floor,
//! with hysteresis, a fast attack and a slow release. Same constants as the
//! TypeScript `Presence` it replaces, so scenes keep their behaviour.

use crate::SILENCE_DB;

const FLOOR_START: f32 = -70.0;
const FLOOR_MIN: f32 = -75.0;
const FLOOR_MAX: f32 = -48.0;
const FLOOR_TRACK: f32 = 24.0;
const FLOOR_STEADY: f32 = 3.0;
const FLOOR_RISE: f32 = 5.0;
const STEADY_TAU: f32 = 0.5;
const OPEN: f32 = 8.0;
const CLOSE: f32 = 4.0;
const HOLD: f32 = 0.3;
const ATTACK: f32 = 0.025;
const RELEASE: f32 = 1.1;

pub struct Presence {
    pub value: f32,
    pub open: bool,
    pub floor: f32,
    steady: f32,
    closing_for: f32,
}

impl Default for Presence {
    fn default() -> Self {
        Self { value: 0.0, open: false, floor: FLOOR_START, steady: SILENCE_DB, closing_for: 0.0 }
    }
}

impl Presence {
    /// `db`: level of the mix (power, ≈ dBFS); `silent`: digitally silent.
    pub fn update(&mut self, db: f32, silent: bool, dt: f32) -> f32 {
        if silent || db <= SILENCE_DB {
            self.open = false;
            self.closing_for = 0.0;
            self.steady = SILENCE_DB;
        } else {
            self.steady = if self.steady <= SILENCE_DB { db } else { self.steady + (db - self.steady) * (1.0 - (-dt / STEADY_TAU).exp()) };
            if db < self.floor {
                self.floor = db.max(FLOOR_MIN);
            } else if db < self.floor + FLOOR_TRACK && (db - self.steady).abs() < FLOOR_STEADY {
                self.floor = (self.floor + FLOOR_RISE * dt).min(db).min(FLOOR_MAX);
            }
            if db > self.floor + OPEN {
                self.open = true;
                self.closing_for = 0.0;
            } else if self.open && db < self.floor + CLOSE {
                self.closing_for += dt;
                if self.closing_for > HOLD {
                    self.open = false;
                }
            } else {
                self.closing_for = 0.0;
            }
        }
        let target = if self.open { 1.0 } else { 0.0 };
        let tau = if target > self.value { ATTACK } else { RELEASE };
        self.value += (target - self.value) * (1.0 - (-dt / tau).exp());
        self.value
    }
}
