var gobble = require( 'gobble' );

gobble.cwd( __dirname );

var node_modules = gobble( 'node_modules', { static: true });

var bundle = node_modules
	.transform( 'concat', {
		dest: 'bundle.js',
		files: [
			'codemirror/lib/codemirror.js',
			'codemirror/mode/javascript/javascript.js',
			'acorn/dist/acorn.js'
		]
	});

var root = gobble( 'src/root' );

var app = gobble([
	gobble( 'src/app' )
		.transform( 'ractive', {
			type: 'es6',
			sourceMap: true
		})
		.transform( 'babel', {
			whitelist: [
				'es6.arrowFunctions',
				'es6.blockScoping',
				'es6.classes',
				'es6.constants',
				'es6.destructuring',
				'es6.parameters.default',
				'es6.parameters.rest',
				'es6.properties.shorthand',
				'es6.spread',
				'es6.templateLiterals'
			],
			inputSourceMap: false
		}),
	gobble( 'src/data' ).transform( 'spelunk', { dest: 'data.js', type: 'es6' })
])
	.transform( 'esperanto-bundle', {
		entry: 'main',
		type: 'cjs',
		sourceMap: true
	})
	.transform( 'derequire' )
	.transform( 'browserify', {
		entries: [ './main' ],
		dest: 'main.js',
		debug: true,
		standalone: 'main'
	});

var css = gobble( 'src/scss' ).transform( 'sass', { src: 'main.scss', dest: 'min.css' });
var lib = node_modules.grab( 'esperanto/dist' ).include( 'esperanto.browser.*' );

// Uglify for production
if ( gobble.env() === 'production' ) {
	app = app.transform( 'uglifyjs' );
	bundle = bundle.transform( 'uglifyjs' );
}

app = app.transform( 'sorcery' );
bundle = bundle.transform( 'sorcery' );

module.exports = gobble([ root, css, app, bundle, lib ]);
