// Zinger Duel — the classic. Two players answer the same prompt, the room
// votes. Prompts come from the locale's big prompt bank (content/locales/*).
import { defineQuipGame } from '../_quip/engine.js';
import { bankProvider } from '../_quip/bank.js';

export default defineQuipGame(
  {
    id: 'zinger-duel',
    name: 'Zinger Duel',
    tagline: 'Two players. One prompt. The room picks the funnier answer.',
    minPlayers: 3,
    maxPlayers: 8,
    accent: '#ff5d8f',
    client: 'zinger-duel', // folder under games/ holding client/host.js + client/player.js
  },
  (ctx) => bankProvider(ctx),
);
