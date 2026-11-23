/**
 * Skills the cooldown overlay tracks: the name as the hotbar shows it, and the cooldown in seconds.
 * The overlay reads each slot's name from the screen, so case, spaces, and punctuation don't need
 * to match. The page's Hotbar tile shows the name read from each slot. IDs use lowercase letters,
 * digits, "_", and "-".
 *
 * Skills after the first block come from the default profiles of the Rogue Lineage Assist Tool
 * (Copyright (c) 2026 Super Gaian, MIT License, see LICENSE). Its weapons, charges, and skills
 * with shared or special cooldowns are left out.
 */
export default [
  { id: "skewer", name: "Skewer", cooldown: 14 },
  { id: "tidal_trident", name: "Tidal Trident", cooldown: 14 },
  { id: "deep_sac", name: "Deep Sacrifice", cooldown: 15 },
  { id: "harpoon", name: "Harpoon", cooldown: 10 },
  { id: "serpent_strike", name: "Serpent Strike", cooldown: 15 },
  { id: "oceans_protection", name: "Ocean's Protection", cooldown: 60 },
  { id: "fishermans_trap", name: "Fisherman's Trap", cooldown: 60 },
  { id: "hunters_focus", name: "Hunter's Focus", cooldown: 30 },

  { id: "pommel_strike", name: "Pommel Strike", cooldown: 15.5 },
  { id: "action_surge", name: "Action Surge", cooldown: 20 },
  { id: "triple_slash", name: "Triple Slash", cooldown: 10 },
  { id: "blade_flash", name: "Blade Flash", cooldown: 10 },
  { id: "swallow_reversal", name: "Swallow Reversal", cooldown: 15 },
  { id: "flowing_counter", name: "Flowing Counter", cooldown: 10 },
  { id: "calm_mind", name: "Calm Mind", cooldown: 45 },
  { id: "needles_eye", name: "Needle's Eye", cooldown: 10.5 },
  { id: "elegant_slash", name: "Elegant Slash", cooldown: 10.5 },
  { id: "interrogation", name: "Interrogation", cooldown: 25.5 },
  { id: "triple_strike", name: "Triple Strike", cooldown: 16 },
  { id: "light_piercer", name: "Light Piercer", cooldown: 9 },
  { id: "chain_pull", name: "Chain Pull", cooldown: 15.6 },
  { id: "impale", name: "Impale", cooldown: 15.5 },
  { id: "subzero_strike", name: "Subzero Strike", cooldown: 15.5 },
  { id: "spear_crusher", name: "Spear Crusher", cooldown: 8.5 },
  { id: "thunder_spear_crash", name: "Thunder Spear Crash", cooldown: 15 },
  { id: "wing_soar", name: "Wing Soar", cooldown: 17 },
  { id: "dragon_roar", name: "Dragon Roar", cooldown: 15 },
  { id: "shoulder_bash", name: "Shoulder Bash", cooldown: 16 },
  { id: "abyssal_scream", name: "Abyssal Scream", cooldown: 15.5 },
  { id: "wrathful_leap", name: "Wrathful Leap", cooldown: 11.6 },
  { id: "lightning_elbow", name: "Lightning Elbow", cooldown: 10.5 },
  { id: "lightning_drop", name: "Lightning Drop", cooldown: 12 },
  { id: "monastic_stance", name: "Monastic Stance", cooldown: 42 },
  { id: "blade_crash", name: "Blade Crash", cooldown: 20 },
  { id: "brandish", name: "Brandish", cooldown: 11 },
  { id: "puncture", name: "Puncture", cooldown: 19 },
  { id: "demon_flip", name: "Demon Flip", cooldown: 8 },
  { id: "spin_kick", name: "Spin Kick", cooldown: 10.5 },
  { id: "axe_kick", name: "Axe Kick", cooldown: 9 },
  { id: "leg_breaker", name: "Leg Breaker", cooldown: 11 },
  { id: "rising_dragon", name: "Rising Dragon", cooldown: 11.5 },
  { id: "shadowrush", name: "Shadowrush", cooldown: 8.7 },
  { id: "owl_slash", name: "Owl Slash", cooldown: 10.8 },
  { id: "grapple", name: "Grapple", cooldown: 7.5 },
  { id: "triple_dagger_throw", name: "Triple Dagger Throw", cooldown: 10.5 },
  { id: "lethality", name: "Lethality", cooldown: 30.5 },
  { id: "shadow_fan", name: "Shadow Fan", cooldown: 10.5 },
  { id: "ethereal_strike", name: "Ethereal Strike", cooldown: 15.5 }
];
