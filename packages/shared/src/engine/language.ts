/**
 * ISO 639 language table. The canonical form is ISO 639-2/T (`eng`, `deu`, `fra`, …); `b` is the
 * 639-2/B code where it differs from `t`, `one` the 639-1 code. Covers every 639-1 language,
 * including the withdrawn `bh` (Bihari) and `sh` (Serbo-Croatian, 639-3 `hbs`, which has no
 * 639-2 code) that still appear in older files.
 */
export const LANGUAGES: ReadonlyArray<{
  t: string;
  b: string | null;
  one: string | null;
  name: string;
}> = [
  { t: 'aar', b: null, one: 'aa', name: 'Afar' },
  { t: 'abk', b: null, one: 'ab', name: 'Abkhazian' },
  { t: 'ave', b: null, one: 'ae', name: 'Avestan' },
  { t: 'afr', b: null, one: 'af', name: 'Afrikaans' },
  { t: 'aka', b: null, one: 'ak', name: 'Akan' },
  { t: 'amh', b: null, one: 'am', name: 'Amharic' },
  { t: 'arg', b: null, one: 'an', name: 'Aragonese' },
  { t: 'ara', b: null, one: 'ar', name: 'Arabic' },
  { t: 'asm', b: null, one: 'as', name: 'Assamese' },
  { t: 'ava', b: null, one: 'av', name: 'Avaric' },
  { t: 'aym', b: null, one: 'ay', name: 'Aymara' },
  { t: 'aze', b: null, one: 'az', name: 'Azerbaijani' },
  { t: 'bak', b: null, one: 'ba', name: 'Bashkir' },
  { t: 'bel', b: null, one: 'be', name: 'Belarusian' },
  { t: 'bul', b: null, one: 'bg', name: 'Bulgarian' },
  { t: 'bih', b: null, one: 'bh', name: 'Bihari languages' },
  { t: 'bis', b: null, one: 'bi', name: 'Bislama' },
  { t: 'bam', b: null, one: 'bm', name: 'Bambara' },
  { t: 'ben', b: null, one: 'bn', name: 'Bengali' },
  { t: 'bod', b: 'tib', one: 'bo', name: 'Tibetan' },
  { t: 'bre', b: null, one: 'br', name: 'Breton' },
  { t: 'bos', b: null, one: 'bs', name: 'Bosnian' },
  { t: 'cat', b: null, one: 'ca', name: 'Catalan' },
  { t: 'che', b: null, one: 'ce', name: 'Chechen' },
  { t: 'cha', b: null, one: 'ch', name: 'Chamorro' },
  { t: 'cos', b: null, one: 'co', name: 'Corsican' },
  { t: 'cre', b: null, one: 'cr', name: 'Cree' },
  { t: 'ces', b: 'cze', one: 'cs', name: 'Czech' },
  { t: 'chu', b: null, one: 'cu', name: 'Church Slavic' },
  { t: 'chv', b: null, one: 'cv', name: 'Chuvash' },
  { t: 'cym', b: 'wel', one: 'cy', name: 'Welsh' },
  { t: 'dan', b: null, one: 'da', name: 'Danish' },
  { t: 'deu', b: 'ger', one: 'de', name: 'German' },
  { t: 'div', b: null, one: 'dv', name: 'Divehi' },
  { t: 'dzo', b: null, one: 'dz', name: 'Dzongkha' },
  { t: 'ewe', b: null, one: 'ee', name: 'Ewe' },
  { t: 'ell', b: 'gre', one: 'el', name: 'Greek' },
  { t: 'eng', b: null, one: 'en', name: 'English' },
  { t: 'epo', b: null, one: 'eo', name: 'Esperanto' },
  { t: 'spa', b: null, one: 'es', name: 'Spanish' },
  { t: 'est', b: null, one: 'et', name: 'Estonian' },
  { t: 'eus', b: 'baq', one: 'eu', name: 'Basque' },
  { t: 'fas', b: 'per', one: 'fa', name: 'Persian' },
  { t: 'ful', b: null, one: 'ff', name: 'Fulah' },
  { t: 'fin', b: null, one: 'fi', name: 'Finnish' },
  { t: 'fij', b: null, one: 'fj', name: 'Fijian' },
  { t: 'fao', b: null, one: 'fo', name: 'Faroese' },
  { t: 'fra', b: 'fre', one: 'fr', name: 'French' },
  { t: 'fry', b: null, one: 'fy', name: 'Western Frisian' },
  { t: 'gle', b: null, one: 'ga', name: 'Irish' },
  { t: 'gla', b: null, one: 'gd', name: 'Scottish Gaelic' },
  { t: 'glg', b: null, one: 'gl', name: 'Galician' },
  { t: 'grn', b: null, one: 'gn', name: 'Guarani' },
  { t: 'guj', b: null, one: 'gu', name: 'Gujarati' },
  { t: 'glv', b: null, one: 'gv', name: 'Manx' },
  { t: 'hau', b: null, one: 'ha', name: 'Hausa' },
  { t: 'heb', b: null, one: 'he', name: 'Hebrew' },
  { t: 'hin', b: null, one: 'hi', name: 'Hindi' },
  { t: 'hmo', b: null, one: 'ho', name: 'Hiri Motu' },
  { t: 'hrv', b: null, one: 'hr', name: 'Croatian' },
  { t: 'hat', b: null, one: 'ht', name: 'Haitian' },
  { t: 'hun', b: null, one: 'hu', name: 'Hungarian' },
  { t: 'hye', b: 'arm', one: 'hy', name: 'Armenian' },
  { t: 'her', b: null, one: 'hz', name: 'Herero' },
  { t: 'ina', b: null, one: 'ia', name: 'Interlingua' },
  { t: 'ind', b: null, one: 'id', name: 'Indonesian' },
  { t: 'ile', b: null, one: 'ie', name: 'Interlingue' },
  { t: 'ibo', b: null, one: 'ig', name: 'Igbo' },
  { t: 'iii', b: null, one: 'ii', name: 'Sichuan Yi' },
  { t: 'ipk', b: null, one: 'ik', name: 'Inupiaq' },
  { t: 'ido', b: null, one: 'io', name: 'Ido' },
  { t: 'isl', b: 'ice', one: 'is', name: 'Icelandic' },
  { t: 'ita', b: null, one: 'it', name: 'Italian' },
  { t: 'iku', b: null, one: 'iu', name: 'Inuktitut' },
  { t: 'jpn', b: null, one: 'ja', name: 'Japanese' },
  { t: 'jav', b: null, one: 'jv', name: 'Javanese' },
  { t: 'kat', b: 'geo', one: 'ka', name: 'Georgian' },
  { t: 'kon', b: null, one: 'kg', name: 'Kongo' },
  { t: 'kik', b: null, one: 'ki', name: 'Kikuyu' },
  { t: 'kua', b: null, one: 'kj', name: 'Kuanyama' },
  { t: 'kaz', b: null, one: 'kk', name: 'Kazakh' },
  { t: 'kal', b: null, one: 'kl', name: 'Kalaallisut' },
  { t: 'khm', b: null, one: 'km', name: 'Khmer' },
  { t: 'kan', b: null, one: 'kn', name: 'Kannada' },
  { t: 'kor', b: null, one: 'ko', name: 'Korean' },
  { t: 'kau', b: null, one: 'kr', name: 'Kanuri' },
  { t: 'kas', b: null, one: 'ks', name: 'Kashmiri' },
  { t: 'kur', b: null, one: 'ku', name: 'Kurdish' },
  { t: 'kom', b: null, one: 'kv', name: 'Komi' },
  { t: 'cor', b: null, one: 'kw', name: 'Cornish' },
  { t: 'kir', b: null, one: 'ky', name: 'Kyrgyz' },
  { t: 'lat', b: null, one: 'la', name: 'Latin' },
  { t: 'ltz', b: null, one: 'lb', name: 'Luxembourgish' },
  { t: 'lug', b: null, one: 'lg', name: 'Ganda' },
  { t: 'lim', b: null, one: 'li', name: 'Limburgish' },
  { t: 'lin', b: null, one: 'ln', name: 'Lingala' },
  { t: 'lao', b: null, one: 'lo', name: 'Lao' },
  { t: 'lit', b: null, one: 'lt', name: 'Lithuanian' },
  { t: 'lub', b: null, one: 'lu', name: 'Luba-Katanga' },
  { t: 'lav', b: null, one: 'lv', name: 'Latvian' },
  { t: 'mlg', b: null, one: 'mg', name: 'Malagasy' },
  { t: 'mah', b: null, one: 'mh', name: 'Marshallese' },
  { t: 'mri', b: 'mao', one: 'mi', name: 'Maori' },
  { t: 'mkd', b: 'mac', one: 'mk', name: 'Macedonian' },
  { t: 'mal', b: null, one: 'ml', name: 'Malayalam' },
  { t: 'mon', b: null, one: 'mn', name: 'Mongolian' },
  { t: 'mar', b: null, one: 'mr', name: 'Marathi' },
  { t: 'msa', b: 'may', one: 'ms', name: 'Malay' },
  { t: 'mlt', b: null, one: 'mt', name: 'Maltese' },
  { t: 'mya', b: 'bur', one: 'my', name: 'Burmese' },
  { t: 'nau', b: null, one: 'na', name: 'Nauru' },
  { t: 'nob', b: null, one: 'nb', name: 'Norwegian Bokmål' },
  { t: 'nde', b: null, one: 'nd', name: 'North Ndebele' },
  { t: 'nep', b: null, one: 'ne', name: 'Nepali' },
  { t: 'ndo', b: null, one: 'ng', name: 'Ndonga' },
  { t: 'nld', b: 'dut', one: 'nl', name: 'Dutch' },
  { t: 'nno', b: null, one: 'nn', name: 'Norwegian Nynorsk' },
  { t: 'nor', b: null, one: 'no', name: 'Norwegian' },
  { t: 'nbl', b: null, one: 'nr', name: 'South Ndebele' },
  { t: 'nav', b: null, one: 'nv', name: 'Navajo' },
  { t: 'nya', b: null, one: 'ny', name: 'Chichewa' },
  { t: 'oci', b: null, one: 'oc', name: 'Occitan' },
  { t: 'oji', b: null, one: 'oj', name: 'Ojibwa' },
  { t: 'orm', b: null, one: 'om', name: 'Oromo' },
  { t: 'ori', b: null, one: 'or', name: 'Odia' },
  { t: 'oss', b: null, one: 'os', name: 'Ossetian' },
  { t: 'pan', b: null, one: 'pa', name: 'Punjabi' },
  { t: 'pli', b: null, one: 'pi', name: 'Pali' },
  { t: 'pol', b: null, one: 'pl', name: 'Polish' },
  { t: 'pus', b: null, one: 'ps', name: 'Pashto' },
  { t: 'por', b: null, one: 'pt', name: 'Portuguese' },
  { t: 'que', b: null, one: 'qu', name: 'Quechua' },
  { t: 'roh', b: null, one: 'rm', name: 'Romansh' },
  { t: 'run', b: null, one: 'rn', name: 'Rundi' },
  { t: 'ron', b: 'rum', one: 'ro', name: 'Romanian' },
  { t: 'rus', b: null, one: 'ru', name: 'Russian' },
  { t: 'kin', b: null, one: 'rw', name: 'Kinyarwanda' },
  { t: 'san', b: null, one: 'sa', name: 'Sanskrit' },
  { t: 'srd', b: null, one: 'sc', name: 'Sardinian' },
  { t: 'snd', b: null, one: 'sd', name: 'Sindhi' },
  { t: 'sme', b: null, one: 'se', name: 'Northern Sami' },
  { t: 'sag', b: null, one: 'sg', name: 'Sango' },
  { t: 'hbs', b: null, one: 'sh', name: 'Serbo-Croatian' },
  { t: 'sin', b: null, one: 'si', name: 'Sinhala' },
  { t: 'slk', b: 'slo', one: 'sk', name: 'Slovak' },
  { t: 'slv', b: null, one: 'sl', name: 'Slovenian' },
  { t: 'smo', b: null, one: 'sm', name: 'Samoan' },
  { t: 'sna', b: null, one: 'sn', name: 'Shona' },
  { t: 'som', b: null, one: 'so', name: 'Somali' },
  { t: 'sqi', b: 'alb', one: 'sq', name: 'Albanian' },
  { t: 'srp', b: null, one: 'sr', name: 'Serbian' },
  { t: 'ssw', b: null, one: 'ss', name: 'Swati' },
  { t: 'sot', b: null, one: 'st', name: 'Southern Sotho' },
  { t: 'sun', b: null, one: 'su', name: 'Sundanese' },
  { t: 'swe', b: null, one: 'sv', name: 'Swedish' },
  { t: 'swa', b: null, one: 'sw', name: 'Swahili' },
  { t: 'tam', b: null, one: 'ta', name: 'Tamil' },
  { t: 'tel', b: null, one: 'te', name: 'Telugu' },
  { t: 'tgk', b: null, one: 'tg', name: 'Tajik' },
  { t: 'tha', b: null, one: 'th', name: 'Thai' },
  { t: 'tir', b: null, one: 'ti', name: 'Tigrinya' },
  { t: 'tuk', b: null, one: 'tk', name: 'Turkmen' },
  { t: 'tgl', b: null, one: 'tl', name: 'Tagalog' },
  { t: 'tsn', b: null, one: 'tn', name: 'Tswana' },
  { t: 'ton', b: null, one: 'to', name: 'Tongan' },
  { t: 'tur', b: null, one: 'tr', name: 'Turkish' },
  { t: 'tso', b: null, one: 'ts', name: 'Tsonga' },
  { t: 'tat', b: null, one: 'tt', name: 'Tatar' },
  { t: 'twi', b: null, one: 'tw', name: 'Twi' },
  { t: 'tah', b: null, one: 'ty', name: 'Tahitian' },
  { t: 'uig', b: null, one: 'ug', name: 'Uyghur' },
  { t: 'ukr', b: null, one: 'uk', name: 'Ukrainian' },
  { t: 'urd', b: null, one: 'ur', name: 'Urdu' },
  { t: 'uzb', b: null, one: 'uz', name: 'Uzbek' },
  { t: 'ven', b: null, one: 've', name: 'Venda' },
  { t: 'vie', b: null, one: 'vi', name: 'Vietnamese' },
  { t: 'vol', b: null, one: 'vo', name: 'Volapük' },
  { t: 'wln', b: null, one: 'wa', name: 'Walloon' },
  { t: 'wol', b: null, one: 'wo', name: 'Wolof' },
  { t: 'xho', b: null, one: 'xh', name: 'Xhosa' },
  { t: 'yid', b: null, one: 'yi', name: 'Yiddish' },
  { t: 'yor', b: null, one: 'yo', name: 'Yoruba' },
  { t: 'zha', b: null, one: 'za', name: 'Zhuang' },
  { t: 'zho', b: 'chi', one: 'zh', name: 'Chinese' },
  { t: 'zul', b: null, one: 'zu', name: 'Zulu' },
];

const BY_CODE: ReadonlyMap<string, string> = new Map(
  LANGUAGES.flatMap((l) => [
    [l.t, l.t],
    ...(l.b === null ? [] : [[l.b, l.t] as const]),
    ...(l.one === null ? [] : [[l.one, l.t] as const]),
  ]),
);

/** Codes that mean "no particular language": undetermined and no linguistic content. */
const NO_LANGUAGE = new Set(['', 'und', 'zxx']);

/**
 * Normalises a language tag to ISO 639-2/T: null, '', 'und' and 'zxx' → null; 'en' → 'eng';
 * 'ger' → 'deu'; 'fre' → 'fra'; case-insensitive. An unknown code is returned lowercased and
 * otherwise unchanged ('unknown' stays 'unknown').
 */
export function normalizeLanguage(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const lower = code.trim().toLowerCase();
  if (NO_LANGUAGE.has(lower)) return null;
  return BY_CODE.get(lower) ?? lower;
}

/** True when both codes are set and normalise to the same language. */
export function sameLanguage(a: string | null, b: string | null): boolean {
  const na = normalizeLanguage(a);
  return na !== null && na === normalizeLanguage(b);
}

/** Names ffprobe and the *arrs use that differ from the table's `name`. */
const NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ['mandarin', 'zho'],
  ['cantonese', 'zho'],
  ['portuguese (brazil)', 'por'],
]);

const BY_NAME: ReadonlyMap<string, string> = new Map(
  LANGUAGES.map((l) => [l.name.toLowerCase(), l.t]),
);

/** English language name → ISO 639-2/T ('Japanese' → 'jpn'); 'Unknown', 'Original', 'Any', '' and unknown names → null. */
export function languageFromName(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (key === '' || key === 'unknown' || key === 'original' || key === 'any') return null;
  return NAME_ALIASES.get(key) ?? BY_NAME.get(key) ?? null;
}

const ISO1_BY_T: ReadonlyMap<string, string> = new Map(
  LANGUAGES.flatMap((l) => (l.one === null ? [] : [[l.t, l.one] as const])),
);

/** ISO 639-1 code for a language code ('jpn' → 'ja'); null when there is none. */
export function iso1Of(code: string | null): string | null {
  const t = normalizeLanguage(code);
  return t === null ? null : (ISO1_BY_T.get(t) ?? null);
}

/** The data-port rule: a language string is normalised; 'und', 'zxx', 'xx', 'unknown', '', null and non-strings are 'unknown'. */
export function normalizeLanguageValue(value: unknown): string | 'unknown' {
  if (typeof value !== 'string') return 'unknown';
  const n = normalizeLanguage(value);
  if (n === null || n === 'xx' || n === 'unknown') return 'unknown';
  return n;
}
