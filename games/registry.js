// Every game on the platform. To add a game: create games/<id>/index.js (server
// logic) + games/<id>/client/{host,player}.js (screens), then add one import
// below. See docs/MAKING_GAMES.md.
import zingerDuel from './zinger-duel/index.js';
import callbackClub from './callback-club/index.js';
import pictureDuel from './picture-duel/index.js';

export const GAMES = [zingerDuel, callbackClub, pictureDuel];

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}
