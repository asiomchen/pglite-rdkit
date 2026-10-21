# Sourced by build-rdkit-libs.sh and build-cartridge.sh.
# InChI is always built. Optional extras: RDKIT_FEATURES="avalon" (default: none). A non-default
# set builds into its own build/*-<features> directories and dist/rdkit-<features>.tar.gz, so it
# never mixes with the default build.
RDK_INCHI=ON
RDK_AVALON=OFF
for feature in ${RDKIT_FEATURES:-}; do
  case $feature in
    avalon) RDK_AVALON=ON ;;
    *) echo "unknown RDKIT_FEATURES entry: $feature (known: avalon)" >&2; exit 1 ;;
  esac
done
FEATURES_SUFFIX=$(for f in ${RDKIT_FEATURES:-}; do echo "$f"; done | sort -u | paste -sd- -)
FEATURES_SUFFIX=${FEATURES_SUFFIX:+-$FEATURES_SUFFIX}
