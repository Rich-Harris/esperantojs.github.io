var gobble = require( 'gobble' ),
	src, root, app, bundle, css, data, lib, vendor;

gobble.cwd( __dirname );
src = gobble( 'src' );

root = gobble( 'src/root' );
app = gobble( 'src/ractive_components' ).map( 'ractive', { type: 'es6' });
bundle = gobble( 'src/bundle' ).transform( 'concat', { files: '**/*.js', dest: 'bundle.js' });
css = gobble( 'src/scss' ).transform( 'sass', { src: 'main.scss', dest: 'min.css' });
lib = gobble( 'node_modules/esperanto/dist', { static: true }).include( 'esperanto.browser.*' );

// Compile the app.html file
data = gobble( 'src/data' ).transform( 'spelunk', { dest: 'data.js', type: 'es6' });
app = gobble([ app, data ]).transform( 'esperanto-bundle', {
	name: 'App',
	entry: 'app.js',
	type: 'umd'
});

// Uglify for production
if ( gobble.isBuild ) {
	app = app.map( 'uglifyjs' );
	bundle = bundle.map( 'uglifyjs' );
	lib = lib.map( 'uglifyjs' );
}

module.exports = gobble([ root, app, bundle, css, lib, 'src/files' ]);
