// Prompt provider backed by the room's locale content pack: regular prompts,
// plus one personalised "{player}" prompt per round so the room gets to judge
// what's written about one of their own.
import { shuffle } from '../../core/util.js';

export function bankProvider(ctx) {
  return {
    roundPrompts(game, round, count) {
      const used = ctx.usedPrompts;
      const personal = count >= 3 ? ctx.content.pickPersonal(1, used) : [];
      const regular = ctx.content.pickPrompts(count - personal.length, used);
      return shuffle([...regular, ...personal]);
    },
    finalPrompt() {
      return ctx.content.pickFinal(ctx.usedPrompts);
    },
    roundTitle(round) {
      return ctx.line(`roundTitle${round}`) || null;
    },
  };
}
