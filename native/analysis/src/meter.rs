//! Causal accent hypotheses (3/4/5/7). A regular pulse alone is not evidence
//! of meter; ambiguity is explicit. This estimates beat grouping, not notation.
const METERS: [usize; 4] = [3, 4, 5, 7];
#[derive(Default)]
pub struct Meter {
    accents: [[f32; 7]; 4],
    seen: u64,
    pub beats: usize,
    pub offset: usize,
    pub confidence: f32,
    /// Accent contrast within the selected grouping, separate from confidence in the grouping itself.
    pub accent_confidence: f32,
    candidate: usize,
    held: u32,
}
impl Meter {
    pub fn accent(&mut self, index: u64, level: f32) {
        self.seen = self.seen.max(index + 1);
        for (h, &n) in METERS.iter().enumerate() {
            let p = index as usize % n;
            self.accents[h][p] += (level - self.accents[h][p]) * 0.2;
        }
        if self.seen < 21 {
            return;
        }
        let mut scores = [0.0f32; 4];
        let mut positions = [0usize; 4];
        for (h, &n) in METERS.iter().enumerate() {
            let a = &self.accents[h][..n];
            let p = (0..n).max_by(|&i, &j| a[i].total_cmp(&a[j])).unwrap_or(0);
            let mean = (a.iter().sum::<f32>() - a[p]) / (n - 1) as f32;
            scores[h] = if a[p] > 1e-5 { ((a[p] - mean) / a[p]).max(0.0) } else { 0.0 };
            positions[h] = p;
        }
        let best = (0..4).max_by(|&i, &j| scores[i].total_cmp(&scores[j])).unwrap_or(1);
        let runner = (0..4).filter(|&i| i != best).map(|i| scores[i]).fold(0.0f32, f32::max);
        let confidence = ((scores[best] - runner) / 0.35).clamp(0.0, 1.0) * scores[best];
        if self.candidate == best {
            self.held += 1;
        } else {
            self.candidate = best;
            self.held = 0;
        }
        if self.held >= 8 && confidence > 0.2 {
            self.beats = METERS[best];
            self.offset = positions[best];
        }
        self.confidence += ((if self.beats == METERS[best] { confidence } else { 0.0 }) - self.confidence) * 0.15;
        let accent = METERS.iter().position(|&n| n == self.beats).map_or(0.0, |h| {
            let a = &self.accents[h][..self.beats];
            let top = a[self.offset];
            let other = a.iter().enumerate().filter(|&(i, _)| i != self.offset).map(|(_, &v)| v).fold(0.0f32, f32::max);
            // Same scale as the original downbeat measure: 1.5x the next accent is fully clear.
            if top > 1e-4 {
                ((top / other.max(1e-6) - 1.0) / 0.5).clamp(0.0, 1.0)
            } else {
                0.0
            }
        });
        self.accent_confidence += (accent - self.accent_confidence) * 0.15;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_groupings_and_abstains_on_equal_accents() {
        for meter in [3, 4, 5, 7] {
            let mut m = Meter::default();
            for i in 0..200 {
                m.accent(i, if i % meter == 0 { 1.0 } else { 0.2 });
            }
            assert_eq!(m.beats, meter as usize);
            assert!(m.confidence > 0.5);
        }
        let mut m = Meter::default();
        for i in 0..200 {
            m.accent(i, 1.0);
        }
        assert!(m.confidence < 0.1);
    }
}
