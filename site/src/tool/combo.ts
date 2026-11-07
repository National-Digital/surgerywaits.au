import {
  EVENT,
  KEY,
  SEL,
  CLS,
  enhanceInput,
  enhanceList,
  make,
  markOption,
  markSelected,
  setActive,
  setOpen,
} from './dom';

export interface Option {
  id: string;
  label: string;
  note?: string;
}

export interface Combo {
  picked: () => Option | null;
  // Lists again, for a search that could not answer until its data arrived.
  refresh: () => void;
}

interface Hooks {
  search: (query: string) => Option[];
  // Told how many options are listed, for the live region.
  listed: (count: number) => void;
  // Told when a pick is made or lost.
  changed: () => void;
  // Told each time the box is about to list, so a caller can load what the search needs.
  used?: () => void;
}

export function combo(field: HTMLElement, hooks: Hooks): Combo | null {
  const input = field.querySelector<HTMLInputElement>(SEL.input);
  const list = field.querySelector<HTMLElement>(SEL.list);
  if (input === null || list === null) {
    return null;
  }
  enhanceInput(input, list.id);
  enhanceList(list, field.querySelector(SEL.label)?.id ?? '');
  let options: Option[] = [];
  let active = -1;
  let picked: Option | null = null;

  const idOf = (i: number): string => `${list.id}-${String(i)}`;
  const highlight = (i: number): void => {
    active = i;
    list.querySelectorAll(SEL.item).forEach((node, at) => {
      markSelected(node, at === i);
    });
    setActive(input, i < 0 ? null : idOf(i));
  };
  const close = (): void => {
    setOpen(input, list, false);
    setActive(input, null);
    active = -1;
  };
  const choose = (i: number): void => {
    const option = options[i];
    if (option === undefined) {
      return;
    }
    picked = option;
    input.value = option.label;
    close();
    hooks.changed();
  };
  const show = (): void => {
    hooks.used?.();
    options = hooks.search(input.value);
    list.replaceChildren(
      ...options.map((option, i) => {
        const node = make.li(CLS.option, option.label);
        markOption(node, idOf(i), false);
        if (option.note !== undefined) {
          node.append(make.span(CLS.note, option.note));
        }
        node.addEventListener(EVENT.mousedown, (event) => {
          event.preventDefault();
          choose(i);
        });
        return node;
      }),
    );
    active = -1;
    setActive(input, null);
    setOpen(input, list, options.length > 0);
    hooks.listed(input.value.trim() === '' ? -1 : options.length);
  };

  input.addEventListener(EVENT.input, () => {
    if (picked !== null) {
      picked = null;
      hooks.changed();
    }
    show();
  });
  input.addEventListener(EVENT.blur, close);
  input.addEventListener(EVENT.keydown, (event) => {
    const open = list.hidden === false;
    if (event.key === KEY.down || event.key === KEY.up) {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const step = event.key === KEY.down ? 1 : -1;
      highlight((active + step + options.length) % options.length);
    } else if (event.key === KEY.enter && open && active >= 0) {
      event.preventDefault();
      choose(active);
    } else if (event.key === KEY.escape && open) {
      event.preventDefault();
      close();
    }
  });
  return {
    picked: () => picked,
    refresh: (): void => {
      if (input.value.trim() !== '' && picked === null && document.activeElement === input) {
        show();
      }
    },
  };
}
