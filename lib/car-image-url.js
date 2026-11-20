export function getCarImageUrl(imageUrl) {
  if (typeof imageUrl === "string" && imageUrl.startsWith("/cars/")) {
    return `/api/images${imageUrl}`;
  }

  if (typeof imageUrl === "string") {
    try {
      const url = new URL(imageUrl);
      if (url.pathname.startsWith("/cars/")) {
        return `/api/images${url.pathname}`;
      }
      if (url.pathname.startsWith("/api/images/cars/")) {
        return `${url.pathname}${url.search}`;
      }
    } catch {
      return imageUrl;
    }
  }

  return imageUrl;
}
