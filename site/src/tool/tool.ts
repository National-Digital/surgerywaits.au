import { combo } from './combo';
import type { Combo, Option } from './combo';
import type { PlaceRow, ToolIndex, ToolPlaces, ToolProcedure } from './data';
import { ATTR, EVENT, SEL, attr } from './dom';
import { normalise, rank, rankPlaces } from './match';
import type { Candidate, Place } from './match';
import { nearest } from './nearest';
import { renderResults } from './results';
import { fill } from '../lib/slots';

const LISTED = 8;
const MIN_PLACE_LETTERS = 2;

interface Entry<T> extends Candidate {
  value: T;
}

// A file of the site, fetched once; a failure is told to the caller.
async function load<T>(address: string): Promise<T> {
  const response = await fetch(address);
  if (!response.ok) {
    throw new Error(String(response.status));
  }
  return (await response.json()) as T;
}

const placeLabel = (place: PlaceRow): { label: string; note?: string } =>
  place[0].endsWith(')') ? { label: place[0] } : { label: place[0], note: place[1] };

function wire(root: HTMLElement, data: ToolIndex): void {
  const form = root.querySelector<HTMLFormElement>(SEL.form);
  const fallback = root.querySelector<HTMLElement>(SEL.fallback);
  const message = root.querySelector<HTMLElement>(SEL.message);
  const mount = document.querySelector<HTMLElement>(SEL.results);
  const fields = root.querySelectorAll<HTMLElement>(SEL.field);
  const [surgeryField, placeField] = [fields[0], fields[1]];
  if (
    form === null ||
    fallback === null ||
    message === null ||
    mount === null ||
    surgeryField === undefined ||
    placeField === undefined
  ) {
    return;
  }
  const t = data.strings;

  const procedures: Entry<number>[] = data.procedures.map((p, i) => ({
    value: i,
    fields: [normalise(p.name), ...p.terms.map(normalise)],
  }));
  let place: Combo | null = null;
  let places: (Place & { value: number })[] = [];
  let spots: PlaceRow[] = [];
  let loading: Promise<void> | null = null;
  const failed = (): void => {
    say(attr(root, ATTR.failed));
  };
  const loadPlaces = (): void => {
    loading ??= load<ToolPlaces>(attr(root, ATTR.places)).then((file) => {
      spots = file.places;
      places = spots.map((p, i) => ({
        value: i,
        state: p[1],
        name: normalise(p[0]),
        fields: [normalise(p[0]), normalise(`${p[0]} ${p[1]}`)],
      }));
      place?.refresh();
    }, failed);
  };
  const procedureFiles = new Map<string, Promise<ToolProcedure>>();
  const loadProcedure = (slug: string): Promise<ToolProcedure> => {
    const known = procedureFiles.get(slug);
    if (known !== undefined) {
      return known;
    }
    const file = load<ToolProcedure>(fill(attr(root, ATTR.procedures), { slug }));
    procedureFiles.set(slug, file);
    file.catch(() => procedureFiles.delete(slug));
    return file;
  };

  const say = (text: string): void => {
    message.textContent = text;
  };
  const count = (n: number): string =>
    n === 0 ? t.count_none : n === 1 ? t.count_one : fill(t.count_many, { count: String(n) });

  const surgery: Combo | null = combo(surgeryField, {
    search: (query): Option[] =>
      rank(procedures, query, LISTED).map(({ item, field }): Option => {
        const procedure = data.procedures[item.value];
        const term = field > 0 ? procedure?.terms[field - 1] : undefined;
        return {
          id: String(item.value),
          label: procedure?.name ?? '',
          ...(term === undefined ? {} : { note: fill(t.found_as, { term }) }),
        };
      }),
    listed: (n) => {
      say(n < 0 ? '' : count(n));
    },
    changed: () => {
      say('');
    },
  });
  place = combo(placeField, {
    used: loadPlaces,
    search: (query): Option[] =>
      normalise(query).length < MIN_PLACE_LETTERS
        ? []
        : rankPlaces(places, query, LISTED).map((item): Option => {
            const row = spots[item.value];
            return {
              id: String(item.value),
              ...(row === undefined ? { label: '' } : placeLabel(row)),
            };
          }),
    listed: (n) => {
      say(n < 0 ? '' : count(n));
    },
    changed: () => {
      say('');
    },
  });
  if (surgery === null || place === null) {
    return;
  }

  form.addEventListener(EVENT.submit, (event) => {
    event.preventDefault();
    const chosenSurgery = surgery.picked();
    const chosenPlace = place.picked();
    if (chosenSurgery === null || chosenPlace === null) {
      say(chosenSurgery === null ? t.need_surgery : t.need_place);
      return;
    }
    const procedure = data.procedures[Number(chosenSurgery.id)];
    const spot = spots[Number(chosenPlace.id)];
    if (procedure === undefined || spot === undefined) {
      return;
    }
    loadProcedure(procedure.slug).then((file) => {
      const rows = file.rows.flatMap((row) => {
        const hospital = data.hospitals[row[0]];
        return hospital === undefined
          ? []
          : [{ hospital: row[0], latitude: hospital[3], longitude: hospital[4], figure: row }];
      });
      const hits = nearest(rows, { latitude: spot[2], longitude: spot[3] }, data.neighbours).map(
        ({ row, km }) => ({ row: row.figure, km }),
      );
      const context = { surgery: procedure.name, place: chosenPlace.label, procedure, file };
      const heading = renderResults(mount, data, context, hits);
      say(fill(t.results_ready, { surgery: context.surgery, place: context.place }));
      mount.focus();
      heading.scrollIntoView();
    }, failed);
  });

  fallback.hidden = true;
  form.hidden = false;
}

async function start(root: HTMLElement): Promise<void> {
  try {
    wire(root, await load<ToolIndex>(attr(root, ATTR.src)));
  } catch {
    const message = root.querySelector<HTMLElement>(SEL.message);
    if (message !== null) {
      message.textContent = attr(root, ATTR.failed);
    }
  }
}

const root = document.querySelector<HTMLElement>(SEL.root);
if (root !== null) {
  void start(root);
}
