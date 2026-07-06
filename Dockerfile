# HPOGraph -- static site, zero backend, no build step. This image just
# serves the compiled app + database with nginx; see README.md for what
# the app itself does.
#
# Build:  docker build -t hpograph .
# Run:    docker run --rm -p 8080:80 hpograph
# Then open http://localhost:8080
FROM nginx:alpine

# Custom server block: disables nginx's own gzip module so it never
# double-handles data/hpo.db.gz (see docker/nginx.conf for why).
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy only what the app actually needs to run -- explicitly, rather than
# COPY . ., so the huge gitignored data/hpo.db (uncompressed, ~46MB) and
# the raw_data/ rebuild inputs never end up in the image even if they
# happen to exist in the build context on disk.
COPY index.html /usr/share/nginx/html/index.html
COPY assets/    /usr/share/nginx/html/assets/
COPY docs/      /usr/share/nginx/html/docs/
COPY data/hpo.db.gz /usr/share/nginx/html/data/hpo.db.gz

# COPY preserves the source files' permission bits. If the files on the
# host aren't world-readable (e.g. mode 600), the nginx worker process --
# which drops from root to an unprivileged user -- can't read them, and
# every request 403s even though the files are clearly present. Force
# read (and directory-traverse) permissions here so this works regardless
# of how the files happen to be permissioned on whatever machine builds
# this image.
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 80
