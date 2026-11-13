
export interface Category {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  is_active: boolean;
}

export interface Product {
  id: string;
  category_id: string;
  name: string;
  telugu_name: string | null;
  description: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface Variant {
  id: string;
  product_id: string;
  name: string;
  quantity: number;
  unit: string;
  price_paise: number;
  compare_at_price_paise: number | null;
  is_default: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface DeliveryZone {
  id: string;
  name: string;
  pincode: string;
  delivery_fee_paise: number;
  minimum_order_paise: number;
  is_active: boolean;
}

export interface DeliverySlot {
  id: string;
  zone_id: string;
  label: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
}

export interface Availability {
  variant_id: string;
  in_stock: boolean;
  fulfilment: string;
}

export interface ProductImage {
  product_id: string;
  storage_path: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  image_url: string;
}

type Table<Row> = {
  Row: Row;
  Insert: never;
  Update: never;
  Relationships: [];
};

// Public read projections inspected against the existing database.
// Writes remain deliberately untyped/disabled until privileged contracts can be inspected.
export interface PublicStoreDatabase {
  public: {
    Tables: {
      categories: Table<Category>;
      products: Table<Product>;
      product_variants: Table<Variant>;
      delivery_zones: Table<DeliveryZone>;
      delivery_slots: Table<DeliverySlot>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export interface Catalogue {
  categories: Category[];
  products: Product[];
  variants: Variant[];
  images: ProductImage[];
  availability: Availability[];
  availabilityError: string | null;
  error: string | null;
}
