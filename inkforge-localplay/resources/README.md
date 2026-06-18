# App icon / splash sources

`icon.png` is the InkForge anvil-in-aperture mark (used for the Android launcher
icon and PWA icons).

The Android launcher icons (res/mipmap-*) are NOT regenerated automatically.
After updating `icon.png`, run the asset generator once (needs Node + sharp):

    npx @capacitor/assets generate --android --iconBackgroundColor '#0b1020'

then commit the regenerated `android/app/src/main/res/mipmap-*` files. The web /
PWA icons come from `public/brand/inkforge-icon.png` and update automatically.
