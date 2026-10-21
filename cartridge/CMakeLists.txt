# Builds the RDKit PostgreSQL cartridge as a PGlite side module that loads into a stock
# @electric-sql/pglite build (see ../README.md).
#
# The upstream cartridge CMake (Code/PgSQL/rdkit) needs a runnable pg_config and pg_regress,
# which we don't have when cross-compiling to wasm. Instead scripts/build-rdkit-libs.sh first
# builds and installs the RDKit static libraries (RDK_BUILD_PGSQL=OFF), and here we compile the
# cartridge sources against the imported RDKit:: targets, so they get the same rdkit_base compile
# definitions as the libraries they link against.
cmake_minimum_required(VERSION 3.18)
project(pglite_rdkit LANGUAGES C CXX)

# must match RDKit's own top-level CMakeLists (the exported targets don't carry it)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(RDKIT_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../upstream/rdkit" CACHE PATH "RDKit source tree")
set(PG_INCLUDE_DIR_SERVER "" CACHE PATH "PostgreSQL server include dir (pg_config --includedir-server)")
if(NOT PG_INCLUDE_DIR_SERVER)
  message(FATAL_ERROR "PG_INCLUDE_DIR_SERVER must be set")
endif()

find_package(RDKit REQUIRED CONFIG)

# optional features (scripts/features.sh); the RDKit libraries must be built with the same set
option(RDK_BUILD_INCHI_SUPPORT "mol_inchi / mol_inchikey (InChI library)" ON)
option(RDK_BUILD_AVALON_SUPPORT "avalon_fp (Avalon toolkit)" OFF)

set(CARTRIDGE_DIR "${RDKIT_SRC_DIR}/Code/PgSQL/rdkit")

add_executable(rdkit
  ${CARTRIDGE_DIR}/adapter.cpp ${CARTRIDGE_DIR}/bfp_op.c ${CARTRIDGE_DIR}/cache.c
  ${CARTRIDGE_DIR}/guc.c ${CARTRIDGE_DIR}/low_gist.c ${CARTRIDGE_DIR}/mol_op.c
  ${CARTRIDGE_DIR}/rdkit_gist.c ${CARTRIDGE_DIR}/bfp_gist.c ${CARTRIDGE_DIR}/bfp_gin.c
  ${CARTRIDGE_DIR}/bitstring.c ${CARTRIDGE_DIR}/rdkit_io.c ${CARTRIDGE_DIR}/rxn_op.c
  ${CARTRIDGE_DIR}/sfp_op.c
  pglite_shims.c libc_shims.c)
set_target_properties(rdkit PROPERTIES SUFFIX ".so")
target_include_directories(rdkit PRIVATE ${CARTRIDGE_DIR} ${PG_INCLUDE_DIR_SERVER})
target_compile_definitions(rdkit PRIVATE
  RDK_TOOLKIT_VERSION="${RDKit_VERSION}"
  RDKITVER="007700")
# The whole C++ runtime is linked into the side module, built for native wasm exceptions, so
# C++ throw/catch never reaches pglite.js (whose ___cxa_throw is abort() in the published build).
target_link_options(rdkit PRIVATE -sSIDE_MODULE=1 -lc++ -lc++abi -lunwind)
if(RDK_BUILD_INCHI_SUPPORT OR RDK_BUILD_AVALON_SUPPORT)
  # adapter.cpp includes <INCHI-API/inchi.h> and <AvalonTools/AvalonTools.h> from External/
  target_include_directories(rdkit PRIVATE ${RDKIT_SRC_DIR}/External)
endif()
if(RDK_BUILD_INCHI_SUPPORT)
  target_compile_definitions(rdkit PRIVATE RDK_BUILD_INCHI_SUPPORT)
  target_link_libraries(rdkit PRIVATE RDKit::RDInchiLib RDKit::Inchi)
endif()
if(RDK_BUILD_AVALON_SUPPORT)
  target_compile_definitions(rdkit PRIVATE RDK_BUILD_AVALON_SUPPORT)
  target_link_libraries(rdkit PRIVATE RDKit::AvalonLib RDKit::avalon_clib)
endif()
# same library list as Code/PgSQL/rdkit/CMakeLists.txt (minus InChI/Avalon/MolInterchange)
target_link_libraries(rdkit PRIVATE
  RDKit::GeneralizedSubstruct RDKit::MolEnumerator RDKit::TautomerQuery RDKit::MolDraw2D
  RDKit::MolTransforms RDKit::MolHash RDKit::FMCS RDKit::ChemReactions RDKit::ChemTransforms
  RDKit::FileParsers RDKit::SmilesParse RDKit::Fingerprints RDKit::Subgraphs RDKit::Descriptors
  RDKit::PartialCharges RDKit::SubstructMatch RDKit::GraphMol RDKit::EigenSolvers
  RDKit::DataStructs RDKit::Depictor RDKit::RDGeometryLib RDKit::RDGeneral RDKit::rdkit_base)

# Generate the extension SQL the same way the upstream cartridge CMake does
# (mol/qmol gist sortsupport ON, bfp gist sortsupport OFF; PostgreSQL >= 17).
set(RDKIT_PG_MOL_GIST_SORTSUPPORT "FUNCTION    11   gmol_sortsupport (internal),")
set(RDKIT_PG_QMOL_GIST_SORTSUPPORT "FUNCTION    11   gmol_sortsupport (internal),")
set(RDKIT_PG_BFP_GIST_SORTSUPPORT "")
set(RDKIT_PG_ALTER_OPERATOR_ATEQ_MOL "ALTER OPERATOR @= (mol, mol) SET (
    COMMUTATOR = '@=',
    NEGATOR = '@<>'
);")
set(RDKIT_PG_ALTER_OPERATOR_ATEQ_REACTION "ALTER OPERATOR @= (reaction, reaction) SET (
    COMMUTATOR = '@=',
    NEGATOR = '@<>'
);")
file(STRINGS ${CARTRIDGE_DIR}/rdkit.control PG_EXTVERSION LIMIT_COUNT 1 REGEX default_version)
string(REGEX REPLACE ".*'([^']*)'.*" "\\1" PG_EXTVERSION "${PG_EXTVERSION}")
configure_file(${CARTRIDGE_DIR}/rdkit.sql.in ${CMAKE_CURRENT_BINARY_DIR}/sql/rdkit--${PG_EXTVERSION}.sql)
file(GLOB update_sql_files "${CARTRIDGE_DIR}/update_sql/*.in")
foreach(file ${update_sql_files})
  get_filename_component(name ${file} NAME)
  string(REPLACE ".in" "" name ${name})
  configure_file(${file} ${CMAKE_CURRENT_BINARY_DIR}/sql/${name})
endforeach()
configure_file(${CARTRIDGE_DIR}/rdkit.control ${CMAKE_CURRENT_BINARY_DIR}/sql/rdkit.control COPYONLY)

install(TARGETS rdkit RUNTIME DESTINATION lib/postgresql)
install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/sql/ DESTINATION share/postgresql/extension)
