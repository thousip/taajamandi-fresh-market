# TaajaMandi Fresh Market

Create a TaajaMandi website project. This must preserve the existing custom storefront design, not use a generic template. Use a mobile-first green and cream palette, Fredoka and Inter typography, product categories, product cards with weight selector (250g, 500g, 1kg), cart, customer login, checkout, order history, admin dashboard, inventory management and delivery staff views. Connect only to the existing Supabase project https://qebdpjzhbqzjbvjqeztl.supabase.co using the public publishable key from project settings; never put service role secrets in frontend. Existing Edge Functions are create-order (COD only), get-my-role, admin-ops, my-deliveries, delivery-update, catalogue-availability. Use real Supabase tables and these functions; never use mock/localStorage orders or fake OTP. There are currently five categories, zero products, zero active delivery zones and zero active delivery slots, so show a clear empty catalogue and do not invent product prices or claim delivery is available. Build the application and report preview URL and any errors; do not publish until verified.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/26049c56-a559-40fe-b560-bad4cd992575).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
