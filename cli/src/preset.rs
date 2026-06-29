// CLI-owned encode presets. Mirrors cli/ffmpeg.js PRESETS so cli and the JS
// converter produce equivalent output. `svt` is the SVT-AV1 preset (0 slowest/
// smallest … 13 fastest/largest).

#[derive(Clone, Copy)]
pub struct Preset {
    pub name: &'static str,
    pub label: &'static str,
    pub fps: u32,
    pub crf: u32,
    pub svt: u32,
    pub denoise: bool,
    pub audio: u32, // Opus bitrate, kbps
}

const PRESETS: &[Preset] = &[
    Preset { name: "screencast",  label: "Screencast",       fps: 15, crf: 34, svt: 6, denoise: true,  audio: 20 },
    Preset { name: "talkinghead", label: "Talking head",     fps: 24, crf: 30, svt: 6, denoise: true,  audio: 24 },
    Preset { name: "squeeze",     label: "Maximum squeeze",  fps: 10, crf: 38, svt: 2, denoise: true,  audio: 16 },
    Preset { name: "near",        label: "Near-transparent", fps: 24, crf: 26, svt: 4, denoise: false, audio: 32 },
];

pub fn preset(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

pub fn names() -> Vec<&'static str> {
    PRESETS.iter().map(|p| p.name).collect()
}

/// Keyframe interval ≈ 2 seconds of frames, floored at 2.
pub fn gop_for(fps: u32) -> u32 {
    (fps * 2).max(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gop_is_two_seconds_floored_at_two() {
        assert_eq!(gop_for(15), 30);
        assert_eq!(gop_for(24), 48);
        assert_eq!(gop_for(0), 2);
    }

    #[test]
    fn presets_resolve_by_name() {
        assert_eq!(preset("screencast").unwrap().svt, 6);
        assert_eq!(preset("squeeze").unwrap().svt, 2);
        assert!(preset("nope").is_none());
        assert!(names().contains(&"near"));
    }
}
