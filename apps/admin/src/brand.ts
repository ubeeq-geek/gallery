const isEversally = String(import.meta.env.VITE_PRODUCT_BRAND || 'ubeeq').trim().toLowerCase() === 'eversally';

export const adminBrand = {
  productName: isEversally ? 'Eversally' : 'Ubeeq',
  memberName: isEversally ? 'Ever' : 'Ubeeqer'
};
