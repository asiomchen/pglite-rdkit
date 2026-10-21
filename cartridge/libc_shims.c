/*
 * libc symbols that RDKit, InChI or libc++ code in rdkit.so references but which some published
 * pglite.wasm releases don't export (see pglite_shims.c for why the export list varies). Each one
 * is built only on functions every 0.5.x release exports (sin, cos, vsnprintf, fread, ...).
 *
 * Deliberately no Postgres headers here: port.h #defines the printf family (vsprintf ->
 * pg_vsprintf, ...), which would silently rename the shims below.
 *
 * These bind inside rdkit.so even on releases that export the real function, so every shim must
 * be a correct implementation, not a placeholder (signal and setenv explain why failing is the
 * correct behaviour for them).
 */
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* float variants used by RDKit's depiction/drawing code; sin/cos are exported */
float
sinf(float x)
{
	return (float) sin(x);
}

float
cosf(float x)
{
	return (float) cos(x);
}

/*
 * RDKit's ControlCHandler (RDGeneral/ControlCHandler.h) installs a SIGINT handler around long
 * computations so Python users can press Ctrl-C; CIPLabeler constructs one. There are no signals
 * in wasm, so the handler could never fire anyway: report failure and let getGotSignal() stay false.
 */
void		(*signal(int sig, void (*handler) (int))) (int)
{
	return SIG_ERR;
}

/*
 * ctype, C locale (Emscripten's musl implements these ASCII-only as well, so results are identical).
 * Used by RDKit's text handling, e.g. MolDraw2D labels and many parsers. The parenthesized names
 * keep musl's ctype.h macros from expanding the definitions.
 */
int
(islower) (int c)
{
	return (unsigned) c - 'a' < 26;
}

int
(isupper) (int c)
{
	return (unsigned) c - 'A' < 26;
}

int
(ispunct) (int c)
{
	return (unsigned) c - 0x21 < 0x5e && !((unsigned) (c | 32) - 'a' < 26) && !((unsigned) c - '0' < 10);
}

/* only tunes stdio buffering; keeping the default buffering is always valid */
void
(setbuf) (FILE *stream, char *buf)
{
}

/*
 * RDKit stores a few global switches in environment variables (setUseLegacyStereoPerception,
 * setAllowNontetrahedralChirality, useLegacyRingFinding) and reads them back with getenv(). Releases
 * before 0.5.10 export neither setenv, putenv nor environ, so a side module can't change what
 * getenv() sees. The cartridge never calls those setters, so fail visibly instead of pretending.
 * The settings can still be given as real environment variables of the PGlite process.
 */
int
(setenv) (const char *name, const char *value, int overwrite)
{
	errno = ENOMEM;
	return -1;
}

/* string functions used by the InChI library */
char *
(stpcpy) (char *dst, const char *src)
{
	size_t		n = strlen(src);

	memcpy(dst, src, n + 1);
	return dst + n;
}

char *
(strpbrk) (const char *s, const char *accept)
{
	s += strcspn(s, accept);
	return *s ? (char *) s : NULL;
}

/* printf family used by InChI; musl implements vsprintf exactly like this */
int
(vsprintf) (char *s, const char *fmt, va_list ap)
{
	return vsnprintf(s, INT_MAX, fmt, ap);
}

/* the compiler emits __small_sprintf for sprintf calls without floating point arguments */
int
__small_sprintf(char *s, const char *fmt,...)
{
	va_list		ap;
	int			ret;

	va_start(ap, fmt);
	ret = vsnprintf(s, INT_MAX, fmt, ap);
	va_end(ap);
	return ret;
}

/*
 * stdio reads used by InChI. Built on fread, which reads the same FILE buffer as the main module's
 * own stdio (including ungetc pushback), so mixing these with real stdio calls stays consistent.
 */
int
(fgetc) (FILE *f)
{
	unsigned char c;

	return fread(&c, 1, 1, f) == 1 ? c : EOF;
}

char *
(fgets) (char *s, int n, FILE *f)
{
	int			i = 0;

	if (n <= 0)
		return NULL;
	while (i < n - 1)
	{
		int			c = fgetc(f);

		if (c == EOF)
			break;
		s[i++] = (char) c;
		if (c == '\n')
			break;
	}
	if (i == 0)
		return NULL;
	s[i] = '\0';
	return s;
}
