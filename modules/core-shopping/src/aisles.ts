/**
 * Aisle templates + keyword auto-detection, shared by the server (parsing, detection, ordering)
 * and the client (chips, picker, grouping). No i18n here: display names come from `aisle.<id>`
 * in locales/<lang>.json, this file only knows the aliases the parser accepts.
 */

export type AisleId = "fruit" | "vegetables" | "bakery" | "pantry" | "fridge" | "frozen" | "sweets" | "drinks" | "household" | "hygiene" | "pets" | "other";

export type AisleTemplate = { id: AisleId; icon: string };

/** Store-walk order: this is also the grouping order of the list. Icons are pixelarticons names from @orbis/ui. */
export const AISLE_TEMPLATES: readonly AisleTemplate[] = [
  { id: "fruit", icon: "apple" },
  { id: "vegetables", icon: "leaf" },
  { id: "bakery", icon: "cake" },
  { id: "pantry", icon: "archive" },
  { id: "fridge", icon: "thermometer" },
  { id: "frozen", icon: "snowflake" },
  { id: "sweets", icon: "gift" },
  { id: "drinks", icon: "coffee" },
  { id: "household", icon: "home" },
  { id: "hygiene", icon: "brush" },
  { id: "pets", icon: "heart" },
  { id: "other", icon: "label" },
];

const RANK: Record<string, number> = Object.fromEntries(AISLE_TEMPLATES.map((a, i) => [a.id, i]));

export function isTemplateAisle(aisle: string | null | undefined): aisle is AisleId {
  return !!aisle && aisle in RANK;
}

export function aisleTemplate(aisle: string | null | undefined): AisleTemplate | null {
  return isTemplateAisle(aisle) ? AISLE_TEMPLATES[RANK[aisle]!]! : null;
}

/** sort key: templates in store order, then free-form aisles alphabetically, no aisle last */
export function compareAisles(a: string | null | undefined, b: string | null | undefined): number {
  const ra = a ? (RANK[a] ?? AISLE_TEMPLATES.length) : AISLE_TEMPLATES.length + 1;
  const rb = b ? (RANK[b] ?? AISLE_TEMPLATES.length) : AISLE_TEMPLATES.length + 1;
  if (ra !== rb) return ra - rb;
  return (a ?? "").localeCompare(b ?? "");
}

/* ---------- normalisation: lowercase, umlaut-insensitive (ä → ae and ä → a) ---------- */

function strip(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** two spellings of a string: "käse" → ["kaese", "kase"] (deduped) */
export function variants(s: string): string[] {
  const lower = s.toLowerCase().trim();
  const ae = strip(lower.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss"));
  const plain = strip(lower.replace(/ß/g, "ss"));
  return ae === plain ? [ae] : [ae, plain];
}

/* ---------- names the parser accepts for `@aisle` (en + de, plus common synonyms) ---------- */

export const AISLE_ALIASES: Record<AisleId, string[]> = {
  fruit: ["fruit", "fruits", "obst", "früchte"],
  vegetables: ["vegetables", "vegetable", "veg", "veggies", "gemüse"],
  bakery: ["bakery", "bread", "backwaren", "bäckerei", "brot", "brote"],
  pantry: ["pantry", "dry", "staples", "vorrat", "vorräte", "trocken", "trockenwaren", "grundnahrung"],
  fridge: ["fridge", "dairy", "cold", "chilled", "kühlregal", "kühl", "kühlung", "kühlschrank", "milchprodukte", "frische"],
  frozen: ["frozen", "freezer", "tiefkühl", "tiefkühlware", "tk", "gefroren"],
  sweets: ["sweets", "candy", "snacks", "snack", "süßes", "süsses", "süßigkeiten", "süsswaren", "naschen", "naschzeug"],
  drinks: ["drinks", "beverages", "getränke", "trinken"],
  household: ["household", "cleaning", "haushalt", "putzen", "reinigung", "putzmittel"],
  hygiene: ["hygiene", "drugstore", "toiletries", "bathroom", "drogerie", "bad", "körperpflege", "pflege", "kosmetik"],
  pets: ["pets", "pet", "tiere", "tier", "haustier", "haustiere", "tierbedarf"],
  other: ["other", "misc", "sonstiges", "sonstige", "andere", "rest"],
};

const ALIAS_INDEX = new Map<string, AisleId>();
for (const t of AISLE_TEMPLATES) {
  ALIAS_INDEX.set(t.id, t.id);
  for (const a of AISLE_ALIASES[t.id]) for (const v of variants(a)) ALIAS_INDEX.set(v, t.id);
}

/**
 * `@obst` / `@fruit` / `@Kühl` → "fruit" / "fridge"; anything else stays as typed (free-form aisle).
 * `extra` maps additional names (e.g. the translated names of the hub's current language) to ids.
 */
export function resolveAisle(input: string | null | undefined, extra?: Record<string, AisleId>): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  for (const v of variants(raw)) {
    const hit = ALIAS_INDEX.get(v);
    if (hit) return hit;
  }
  if (extra) {
    const map = new Map<string, AisleId>();
    for (const [name, id] of Object.entries(extra)) for (const v of variants(name)) map.set(v, id);
    for (const v of variants(raw)) {
      const hit = map.get(v);
      if (hit) return hit;
    }
  }
  return raw;
}

/* ---------- keyword dictionary for auto-detection (en + de) ---------- */

/**
 * Matching rule: keywords with 4+ characters match anywhere in the item name ("vollkornbrot" → brot),
 * shorter ones only at a word start ("eis" does not hit "reis"). The longest matching keyword wins,
 * so "ice cream" beats "cream", "dish soap" beats "soap", "tortilla chips" beats "tortilla".
 */
export const AISLE_KEYWORDS: Record<AisleId, string[]> = {
  fruit: [
    "apfel", "äpfel", "apple", "banane", "banana", "beere", "berry", "berries", "erdbeer", "strawberr", "himbeer", "raspberr", "blaubeer", "heidelbeer", "blueberr", "johannisbeer", "brombeer", "blackberr",
    "trauben", "weintrauben", "grape", "orange", "mandarine", "clementine", "zitrone", "lemon", "limette", "lime", "birne", "pear", "pfirsich", "peach", "nektarine", "nectarine", "pflaume", "plum", "zwetschge",
    "kirsche", "cherry", "cherries", "melone", "melon", "ananas", "pineapple", "mango", "kiwi", "avocado", "grapefruit", "aprikose", "apricot", "feige", "fig", "dattel", "granatapfel", "pomegranate", "papaya",
    "maracuja", "passion fruit", "litschi", "lychee", "kaki", "persimmon", "rhabarber", "rhubarb", "obst", "fruit", "früchte",
  ],
  vegetables: [
    "tomate", "tomato", "salat", "lettuce", "salad", "zwiebel", "onion", "kartoffel", "potato", "gurke", "cucumber", "paprika", "bell pepper", "karotte", "möhre", "carrot", "brokkoli", "broccoli", "blumenkohl",
    "cauliflower", "zucchini", "courgette", "aubergine", "eggplant", "spinat", "spinach", "lauch", "leek", "porree", "knoblauch", "garlic", "pilz", "champignon", "mushroom", "kohl", "cabbage", "kürbis", "pumpkin",
    "squash", "sellerie", "celery", "rucola", "rocket", "arugula", "radieschen", "radish", "spargel", "asparagus", "bohnen", "green beans", "erbsen", "peas", "mais", "corn", "ingwer", "ginger", "kräuter", "herbs",
    "petersilie", "parsley", "basilikum", "basil", "schnittlauch", "chives", "dill", "koriander", "cilantro", "süßkartoffel", "sweet potato", "rote bete", "beetroot", "fenchel", "fennel", "frühlingszwiebel",
    "spring onion", "scallion", "chili", "artischocke", "artichoke", "mangold", "chard", "grünkohl", "kale", "rosenkohl", "sprouts", "pak choi", "bok choy", "gemüse", "vegetable", "veggies",
  ],
  bakery: [
    "brot", "bread", "brötchen", "semmel", "buns", "burger buns", "rolls", "baguette", "croissant", "toast", "bagel", "brezel", "pretzel", "kuchen", "cake", "muffin", "laugen", "zopf", "ciabatta", "fladenbrot",
    "pita", "naan", "wrap", "tortilla", "knäckebrot", "crispbread", "zwieback", "donut", "doughnut", "berliner", "krapfen", "stollen", "focaccia", "backwaren", "bakery",
  ],
  pantry: [
    "nudeln", "pasta", "spaghetti", "penne", "fusilli", "tagliatelle", "lasagne", "lasagna", "gnocchi", "reis", "rice", "mehl", "flour", "zucker", "sugar", "salz", "salt", "pfeffer", "pepper", "dose", "dosen",
    "canned", "can of", "tin of", "konserve", "dosentomaten", "tomatenmark", "tomato paste", "passata", "gewürz", "spice", "öl", "oil", "olivenöl", "olive oil", "sonnenblumenöl", "rapsöl", "essig", "vinegar",
    "senf", "mustard", "ketchup", "mayo", "mayonnaise", "soße", "sosse", "sauce", "sojasauce", "sojasoße", "soy sauce", "brühe", "broth", "stock", "bouillon", "haferflocken", "oats", "oatmeal", "porridge",
    "müsli", "muesli", "cereal", "cornflakes", "granola", "honig", "honey", "marmelade", "jam", "nutella", "erdnussbutter", "peanut butter", "linsen", "lentils", "kichererbsen", "chickpeas", "kidneybohnen",
    "kidney beans", "baked beans", "couscous", "bulgur", "quinoa", "hirse", "backpulver", "baking powder", "hefe", "yeast", "vanille", "vanilla", "kakao", "cocoa", "kaffee", "coffee", "espresso", "tee", "tea",
    "nüsse", "nuts", "mandeln", "almonds", "walnüsse", "walnuts", "cashew", "erdnüsse", "peanuts", "rosinen", "raisins", "curry", "paprikapulver", "zimt", "cinnamon", "oregano", "semmelbrösel", "breadcrumbs",
    "kokosmilch", "coconut milk", "thunfisch dose", "canned tuna", "sardinen", "sardines", "pesto", "polenta", "grieß", "semolina", "puderzucker", "icing sugar", "vanillezucker", "stärke", "cornstarch",
    "gelatine", "gelatin", "sirup", "syrup", "ahornsirup", "maple syrup", "vorrat", "pantry",
  ],
  fridge: [
    "milch", "milk", "joghurt", "yogurt", "yoghurt", "käse", "cheese", "butter", "eier", "egg", "eggs", "wurst", "sausage", "schinken", "ham", "salami", "hähnchen", "hühnchen", "chicken", "huhn", "rind", "beef",
    "schwein", "pork", "hack", "hackfleisch", "mince", "minced", "ground beef", "fleisch", "meat", "steak", "fisch", "fish", "lachs", "salmon", "forelle", "trout", "garnele", "shrimp", "prawn", "sahne", "cream",
    "schlagsahne", "whipping cream", "quark", "frischkäse", "cream cheese", "mozzarella", "feta", "parmesan", "gouda", "emmentaler", "camembert", "brie", "halloumi", "tofu", "aufschnitt", "cold cuts", "speck",
    "bacon", "würstchen", "hot dog", "margarine", "buttermilch", "buttermilk", "kefir", "skyr", "pudding", "hummus", "teig", "dough", "lyoner", "mortadella", "putenbrust", "turkey", "pute", "lamm", "lamb",
    "hafermilch", "oat milk", "sojamilch", "soy milk", "mandelmilch", "almond milk", "crème fraîche", "creme fraiche", "schmand", "sour cream", "saure sahne", "tzatziki", "kräuterbutter", "fleischsalat",
    "leberwurst", "bratwurst", "kochschinken", "kühlregal", "fridge", "dairy",
  ],
  frozen: ["tiefkühl", "tk-", "frozen", "pizza", "eis", "ice cream", "eiscreme", "pommes", "fries", "fischstäbchen", "fish fingers", "fish sticks", "gefror", "tiefgefroren", "eiswürfel", "ice cubes", "eis am stiel", "popsicle", "frühlingsrollen", "spring rolls"],
  sweets: [
    "schokolade", "chocolate", "schoko", "gummibärchen", "gummi", "gummy", "haribo", "chips", "crisps", "kekse", "cookies", "cookie", "keks", "biscuit", "bonbon", "candy", "süßigkeit", "sweets", "riegel",
    "snickers", "mars", "twix", "kitkat", "milka", "lakritz", "liquorice", "licorice", "popcorn", "cracker", "crackers", "salzstangen", "pretzel sticks", "pralinen", "praline", "kaugummi", "chewing gum",
    "lutscher", "lollipop", "marshmallow", "nachos", "tortilla chips", "waffeln", "wafer", "lebkuchen", "gingerbread", "m&m", "oreo", "kinder", "nougat", "marzipan", "fruchtgummi", "studentenfutter",
    "trail mix", "schokoriegel", "candy bar", "süßes", "snacks",
  ],
  drinks: [
    "wasser", "water", "cola", "coke", "pepsi", "bier", "beer", "saft", "juice", "wein", "wine", "sekt", "prosecco", "champagner", "champagne", "limo", "limonade", "lemonade", "soda", "sprite", "fanta",
    "energy", "redbull", "red bull", "eistee", "iced tea", "apfelschorle", "schorle", "mineralwasser", "sprudel", "tonic", "gin", "wodka", "vodka", "whisky", "whiskey", "rum", "likör", "liqueur", "radler",
    "cider", "apfelsaft", "orangensaft", "smoothie", "getränk", "drinks", "kombucha", "mate", "spezi", "aperol", "hugo", "tequila", "tetrapak",
  ],
  household: [
    "spülmittel", "dish soap", "dishwashing", "washing up", "spülmaschine", "dishwasher", "tabs", "klopapier", "toilettenpapier", "toilet paper", "loo roll", "müllbeutel", "müllsack", "bin bag", "trash bag",
    "garbage bag", "küchenrolle", "paper towel", "kitchen roll", "taschentücher", "tissues", "waschmittel", "detergent", "laundry", "weichspüler", "fabric softener", "putzmittel", "cleaner", "allzweckreiniger",
    "glasreiniger", "glass cleaner", "badreiniger", "schwamm", "sponge", "spülschwamm", "lappen", "cloth", "alufolie", "aluminium foil", "foil", "frischhaltefolie", "cling film", "plastic wrap", "backpapier",
    "baking paper", "parchment", "gefrierbeutel", "freezer bag", "kerzen", "candles", "teelichter", "batterien", "batteries", "glühbirne", "light bulb", "servietten", "napkins", "entkalker", "descaler",
    "wc-reiniger", "wc reiniger", "toilet cleaner", "bleach", "bleiche", "staubsaugerbeutel", "vacuum bag", "feuerzeug", "lighter", "streichhölzer", "matches", "zahnstocher", "toothpicks", "haushalt",
    "household", "klarspüler", "rinse aid", "spülmaschinensalz", "gummihandschuhe", "rubber gloves", "scheuermilch", "schwämme",
  ],
  hygiene: [
    "zahnpasta", "toothpaste", "zahnbürste", "toothbrush", "shampoo", "duschgel", "shower gel", "body wash", "seife", "soap", "hand soap", "handseife", "deo", "deodorant", "rasierer", "razor", "rasierschaum",
    "shaving", "rasierklingen", "creme", "hand cream", "handcreme", "face cream", "gesichtscreme", "sun cream", "sunscreen", "sonnencreme", "lotion", "bodylotion", "tampons", "tampon", "binden", "pads",
    "slipeinlagen", "windeln", "diapers", "nappies", "feuchttücher", "wet wipes", "wipes", "wattestäbchen", "cotton buds", "q-tips", "watte", "cotton", "haarspray", "hairspray", "haargel", "hair gel",
    "spülung", "conditioner", "mundwasser", "mouthwash", "zahnseide", "floss", "nagellack", "nail polish", "pflaster", "plaster", "band-aid", "bandaid", "lippenpflege", "lip balm", "labello", "kondome",
    "condoms", "haargummi", "make-up", "makeup", "mascara", "aspirin", "ibuprofen", "paracetamol", "vitamine", "vitamins", "drogerie", "hygiene", "toiletries", "nasenspray", "nasal spray", "ohrstäbchen",
    "abschminktücher",
  ],
  pets: [
    "katzenfutter", "cat food", "catfood", "hundefutter", "dog food", "dogfood", "katzenstreu", "cat litter", "litter", "leckerli", "leckerlis", "treats", "kauknochen", "chew", "futter", "pet food", "tierfutter",
    "trockenfutter", "nassfutter", "kibble", "vogelfutter", "bird food", "fischfutter", "fish food", "hund", "dog", "katze", "cat", "hamster", "meerschweinchen", "guinea pig", "kaninchen", "rabbit", "heu", "hay",
    "streu", "haustier", "pets",
  ],
  other: [],
};

type Compiled = { id: AisleId; kw: string; forms: string[] };
let compiled: Compiled[] | null = null;
function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = [];
  for (const t of AISLE_TEMPLATES) for (const kw of AISLE_KEYWORDS[t.id]) compiled.push({ id: t.id, kw, forms: variants(kw) });
  return compiled;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hits(nameForms: string[], kwForms: string[]): boolean {
  for (const kw of kwForms) {
    if (kw.length >= 4) {
      for (const n of nameForms) if (n.includes(kw)) return true;
    } else {
      const re = new RegExp(`(^|[^a-z])${escapeRe(kw)}`);
      for (const n of nameForms) if (re.test(n)) return true;
    }
  }
  return false;
}

/** Guess the aisle of an item name from the keyword dictionary. null when nothing matches. */
export function detectAisle(name: string): AisleId | null {
  const forms = variants(name);
  if (!forms[0]) return null;
  let best: Compiled | null = null;
  for (const c of compile()) {
    if (best && c.kw.length <= best.kw.length) continue;
    if (hits(forms, c.forms)) best = c;
  }
  return best?.id ?? null;
}
