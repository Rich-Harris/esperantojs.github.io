var gobble = require( 'gobble' ),
	src, root, app, bundle, css, data, lib, vendor;

gobble.cwd( __dirname );
src = gobble( 'src' );

root = gobble( 'src/root' );
app = gobble( 'src/ractive_components' ).map( 'ractive' );
bundle = gobble( 'src/bundle' ).transform( 'concat', { files: '**/*.js', dest: 'bundle.js' });
css = gobble( 'src/scss' ).transform( 'sass', { src: 'main.scss', dest: 'min.css' });
lib = gobble( 'node_modules/esperanto/dist', { static: true }).include( 'esperanto.browser.*' );

// Compile the app.html file
data = gobble( 'src/data' ).transform( 'spelunk', { dest: 'data.js', type: 'amd' });
vendor = gobble( 'src/vendor', { static: true });
app = gobble([ app, data, vendor ]).transform( 'requirejs', {
	name: 'app',
	out: 'app.js',
	paths: {
		acorn: 'empty:',
		esperanto: 'empty:',
		ractive: 'ractive/ractive-legacy'
	},
	optimize: 'none'
}).map( 'amdclean', {
	wrap: {
		start: 'var App = (function () {',
		end: 'return app;}());'
	}
});

// Uglify for production
if ( gobble.isBuild ) {
	app = app.map( 'uglifyjs' );
	bundle = bundle.map( 'uglifyjs' );
	lib = lib.map( 'uglifyjs' );
}

module.exports = gobble([ root, app, bundle, css, lib, 'src/files' ]);
