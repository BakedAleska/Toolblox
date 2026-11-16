/**
 * Skills the cooldown overlay tracks: the name as the hotbar shows it, and the cooldown in seconds.
 * The overlay reads each slot's name from the screen, so case, spaces, and punctuation don't need
 * to match. The page's Hotbar tile shows the name read from each slot. IDs use lowercase letters,
 * digits, "_", and "-".
 */
export default [
  { id: "skewer", name: "Skewer", cooldown: 14 },
  { id: "tidal_trident", name: "Tidal Trident", cooldown: 14},
  { id: "deep_sac", name: "Deep Sacrifice", cooldown: 15},
  { id: "harpoon", name: "Harpoon", cooldown: 10},
  { id: "serpent_strike", name: "Serpent Strike", cooldown: 15},
  { id: "oceans_protection", name: "Ocean's Protection", cooldown: 60},
  { id: "fishermans_trap", name: "Fisherman's Trap", cooldown: 60},
  { id: "hunters_focus", name: "Hunter's Focus", cooldown: 30}
];
