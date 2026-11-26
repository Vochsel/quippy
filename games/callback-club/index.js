// Callback Club — the AI mode. Same head-to-head format as Zinger Duel, but the
// prompts are written live for this crew: tailor-made in round 1, callbacks to
// tonight's answers in round 2, and a Grand Callback final. It reads and grows
// the crew's Lore Book, adapts to how the room is playing, and the host reacts
// to each matchup with a fresh one-liner.
import { defineQuipGame } from '../_quip/engine.js';
import { callbackBrain } from './brain.js';

export default defineQuipGame(
  {
    id: 'callback-club',
    name: 'Callback Club',
    tagline: 'Prompts written live about YOU, your running jokes and tonight’s answers.',
    minPlayers: 3,
    maxPlayers: 8,
    accent: '#3fd0c9',
    usesAi: true,
    client: 'callback-club',
  },
  (ctx) => callbackBrain(ctx),
);
