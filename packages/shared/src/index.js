"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertNonEmpty = exports.isPremiumGallery = void 0;
const isPremiumGallery = (gallery) => gallery.visibility === 'premium';
exports.isPremiumGallery = isPremiumGallery;
const assertNonEmpty = (value, fieldName) => {
    if (!value || !value.trim()) {
        throw new Error(`${fieldName} is required`);
    }
    return value.trim();
};
exports.assertNonEmpty = assertNonEmpty;
