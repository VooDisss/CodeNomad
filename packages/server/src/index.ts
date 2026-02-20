/**
 * CLI entry point.
 * For now this only wires the typed modules together; actual command handling comes later.
 */

const argv = process.argv.slice(2)
if (argv[0] === "upgrade") {
  import("./installation/index.js").then(({ upgradeServer }) => {
    const version = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined
    upgradeServer({
      version,
      logger: {
        info: console.log,
        warn: console.warn,
        error: console.error,
      },
    }).then((result) => {
      if (!result.success) {
        process.exit(1)
      }
    })
  })
} else {
  import("./main.js").then(({ main }) => main())
}
