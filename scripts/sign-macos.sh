#!/bin/bash
# Signs, notarizes and packages the macOS build on a Mac with a Developer ID certificate.
#
#   scripts/sign-macos.sh Microsim-macOS-unsigned.zip 0.9.0
#
# Needs: Xcode command line tools, a "Developer ID Application" identity in the login keychain, and
# notarization credentials stored once with:
#   xcrun notarytool store-credentials microsim-notary --apple-id <id> --team-id <team>
# Set NOTARY_PROFILE to use another profile, or SKIP_NOTARIZE=1 to sign only.
set -euo pipefail

zip="${1:?usage: sign-macos.sh <unsigned app zip> <version>}"
version="${2:?usage: sign-macos.sh <unsigned app zip> <version>}"
profile="${NOTARY_PROFILE:-microsim-notary}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

identity="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
[ -n "$identity" ] || { echo "No Developer ID Application identity in the keychain." >&2; exit 1; }
echo "Signing with: $identity"

ditto -x -k "$zip" "$work"
app="$work/Microsim.app"
[ -d "$app" ] || { echo "The zip does not contain Microsim.app." >&2; exit 1; }
xattr -cr "$app"

# Sign inner code first, then the app, with the hardened runtime and a secure timestamp.
find "$app/Contents" -type f \( -perm -u+x -o -name "*.dylib" \) ! -path "*/Contents/MacOS/microsim" -print0 |
  while IFS= read -r -d '' file; do
    if file "$file" | grep -q "Mach-O"; then codesign --force --options runtime --timestamp --sign "$identity" "$file"; fi
  done
codesign --force --options runtime --timestamp --sign "$identity" "$app"
codesign --verify --strict --deep --verbose=2 "$app"

out="$(pwd)/Microsim_${version}_universal.dmg"
rm -f "$out"
stage="$work/dmg"
mkdir "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "Microsim $version" -srcfolder "$stage" -ov -format UDZO "$out" >/dev/null
codesign --force --timestamp --sign "$identity" "$out"

if [ "${SKIP_NOTARIZE:-0}" != "1" ]; then
  xcrun notarytool submit "$out" --keychain-profile "$profile" --wait
  xcrun stapler staple "$out"
  xcrun stapler validate "$out"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$out"
fi
shasum -a 256 "$out"
echo "Done: $out"
