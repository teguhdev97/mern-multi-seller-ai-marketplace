export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Seller {
  id: string;
  userId: string;
  username: string | null;
  name: string;
  image: string | null;
  description: string | null;
  approved: boolean;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discount: number;
  category: string;
  images: string[];
  stock: number;
  sizes: string[];
  colors: string[];
  gender: string | null;
  status: string;
  rejectionReason: string | null;
  sellerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Address {
  id: string;
  userId: string;
  label: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Phone {
  id: string;
  userId: string;
  number: string;
  label: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Promo {
  id: string;
  code: string;
  discountPercent: number;
  active: boolean;
  sellerId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: string;
  userId: string;
  status: string;
  deliveryStatus: string;
  paymentMethod: string;
  paymentStatus: string;
  addressId: string | null;
  phoneId: string | null;
  addressSnapshot: unknown | null;
  phoneNumber: string | null;
  promoCode: string | null;
  discount: number;
  subtotal: number;
  deliveryFee: number;
  total: number;
  stripeSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  price: number;
  sellerId: string;
}

export interface Review {
  id: string;
  productId: string;
  userId: string;
  rating: number;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewComment {
  id: string;
  reviewId: string;
  userId: string;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiInsight {
  id: string;
  sellerId: string;
  type: string;
  content: string;
  createdAt: Date;
}

export interface AiInsightStream {
  id: string;
  sellerId: string;
  type: string;
  status: string;
  chunks: string[];
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}
