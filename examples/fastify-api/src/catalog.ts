export type CatalogLang = 'en' | 'fr' | 'es';

export interface LocalizedCopy {
  name: string;
  category: string;
}

export interface CatalogProduct {
  id: number;
  sku: string;
  price: number;
  copy: Record<CatalogLang, LocalizedCopy>;
}

export interface PublicProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
}

export const CATALOG: CatalogProduct[] = [
  {
    id: 1,
    sku: 'kb-01',
    price: 129,
    copy: {
      en: { name: 'Mechanical Keyboard', category: 'peripherals' },
      fr: { name: 'Clavier mécanique', category: 'périphériques' },
      es: { name: 'Teclado mecánico', category: 'periféricos' },
    },
  },
  {
    id: 2,
    sku: 'ms-02',
    price: 79,
    copy: {
      en: { name: 'Wireless Mouse', category: 'peripherals' },
      fr: { name: 'Souris sans fil', category: 'périphériques' },
      es: { name: 'Ratón inalámbrico', category: 'periféricos' },
    },
  },
  {
    id: 3,
    sku: 'hd-03',
    price: 249,
    copy: {
      en: { name: 'Studio Headphones', category: 'audio' },
      fr: { name: 'Casque studio', category: 'audio' },
      es: { name: 'Auriculares de estudio', category: 'audio' },
    },
  },
  {
    id: 4,
    sku: 'mn-04',
    price: 399,
    copy: {
      en: { name: '4K Monitor', category: 'displays' },
      fr: { name: 'Moniteur 4K', category: 'écrans' },
      es: { name: 'Monitor 4K', category: 'pantallas' },
    },
  },
  {
    id: 5,
    sku: 'dk-05',
    price: 189,
    copy: {
      en: { name: 'Standing Desk Converter', category: 'furniture' },
      fr: { name: 'Convertisseur de bureau debout', category: 'mobilier' },
      es: { name: 'Conversor de escritorio de pie', category: 'mobiliario' },
    },
  },
  {
    id: 6,
    sku: 'wb-06',
    price: 59,
    copy: {
      en: { name: 'Webcam 1080p', category: 'peripherals' },
      fr: { name: 'Webcam 1080p', category: 'périphériques' },
      es: { name: 'Cámara web 1080p', category: 'periféricos' },
    },
  },
  {
    id: 7,
    sku: 'sp-07',
    price: 149,
    copy: {
      en: { name: 'Desktop Speakers', category: 'audio' },
      fr: { name: 'Haut-parleurs de bureau', category: 'audio' },
      es: { name: 'Altavoces de escritorio', category: 'audio' },
    },
  },
  {
    id: 8,
    sku: 'ht-08',
    price: 89,
    copy: {
      en: { name: 'USB Hub', category: 'peripherals' },
      fr: { name: 'Hub USB', category: 'périphériques' },
      es: { name: 'Concentrador USB', category: 'periféricos' },
    },
  },
  {
    id: 9,
    sku: 'lt-09',
    price: 45,
    copy: {
      en: { name: 'Desk Lamp', category: 'furniture' },
      fr: { name: 'Lampe de bureau', category: 'mobilier' },
      es: { name: 'Lámpara de escritorio', category: 'mobiliario' },
    },
  },
  {
    id: 10,
    sku: 'pd-10',
    price: 69,
    copy: {
      en: { name: 'Laptop Stand', category: 'furniture' },
      fr: { name: 'Support pour ordinateur portable', category: 'mobilier' },
      es: { name: 'Soporte para portátil', category: 'mobiliario' },
    },
  },
  {
    id: 11,
    sku: 'mc-11',
    price: 119,
    copy: {
      en: { name: 'USB Microphone', category: 'audio' },
      fr: { name: 'Microphone USB', category: 'audio' },
      es: { name: 'Micrófono USB', category: 'audio' },
    },
  },
  {
    id: 12,
    sku: 'dp-12',
    price: 219,
    copy: {
      en: { name: 'Ultrawide Display', category: 'displays' },
      fr: { name: 'Écran ultra-large', category: 'écrans' },
      es: { name: 'Pantalla ultrawide', category: 'pantallas' },
    },
  },
];

const SUPPORTED: CatalogLang[] = ['en', 'fr', 'es'];

/** Map `Accept-Language` to a catalog locale. Unrecognized values fall back to `en`. */
export function resolveLanguage(header: string | string[] | undefined): CatalogLang {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return 'en';

  const tokens = raw.toLowerCase().split(',');
  for (const token of tokens) {
    const tag = token.split(';')[0]?.trim() ?? '';
    const base = tag.split('-')[0] ?? '';
    if (SUPPORTED.includes(base as CatalogLang)) {
      return base as CatalogLang;
    }
  }
  return 'en';
}

export function localizeProduct(product: CatalogProduct, lang: CatalogLang): PublicProduct {
  const copy = product.copy[lang];
  return {
    id: product.id,
    sku: product.sku,
    name: copy.name,
    category: copy.category,
    price: product.price,
  };
}

export function paginateCatalog(lang: CatalogLang, page: number, limit: number): {
  items: PublicProduct[];
  total: number;
} {
  const items = CATALOG.map((product) => localizeProduct(product, lang));
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total: items.length,
  };
}
