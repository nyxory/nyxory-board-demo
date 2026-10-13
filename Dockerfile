# Ein Prozess, keine Abhängigkeiten — der Build ist ein reines COPY.
# node:sqlite und node:http kommen aus der Runtime, deshalb kein npm install.

# Stufe 1 liest den Commit aus dem mitgeklonten .git (ohne git-Binary), damit
# in der Ops-Leiste der deployte Stand steht, und legt das Datenverzeichnis an.
FROM node:24-trixie-slim AS vorbereitung
WORKDIR /src
COPY .git .git
RUN node -e "\
const fs=require('fs');\
const g='/src/.git';\
let v='';\
try{\
  const head=fs.readFileSync(g+'/HEAD','utf8').trim();\
  if(head.startsWith('ref: ')){\
    const ref=head.slice(5).trim();\
    try{ v=fs.readFileSync(g+'/'+ref,'utf8').trim(); }catch{\
      const packed=fs.readFileSync(g+'/packed-refs','utf8');\
      const z=packed.split('\n').find(l=>l.endsWith(' '+ref));\
      if(z) v=z.split(' ')[0];\
    }\
  } else v=head;\
}catch{}\
fs.writeFileSync('/version.txt', v.slice(0,7));" \
 && mkdir -p /data

# Laufzeit: distroless (keine Shell, kein Paketmanager), als nonroot (65532).
FROM gcr.io/distroless/nodejs24-debian13:nonroot
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json server.mjs theme.json ./
COPY public/ ./public/
COPY --from=vorbereitung /version.txt /app/.app-version
# SQLite liegt standardmäßig im Container (überlebt Prozess-Restarts, nicht
# den Pod). Für echte Persistenz ein Volume mounten, DB_PATH darauf zeigen.
COPY --from=vorbereitung --chown=65532:65532 /data /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
USER 65532:65532
CMD ["server.mjs"]
