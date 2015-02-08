(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('ractive')) :
  typeof define === 'function' && define.amd ? define(['ractive'], factory) :
  global.App = factory(global.Ractive)
}(this, function (Ractive) { 'use strict';

  var __import0______options__ = {
  	template: {v:3,t:[{p:[1,1,0],t:7,e:"div",a:{"class":"codemirror-container",style:[{t:4,f:["height: ",{t:2,r:"height",p:[1,61,60]},";"],r:"height",p:[1,42,41]}]},f:[{p:[2,2,86],t:7,e:"textarea"}]}]},
  },
  __import0____component={},
  __import0______prop__,
  __import0______export__;

  	var keyNames = {
  		'13': 'enter'
  	};

  	__import0____component.exports = {
  		onrender: function () {
  			var component = this, mode, editor, doc, updating;

  			mode = this.get( 'mode' );

  			if ( mode === 'json' ) {
  				mode = {
  					name: 'javascript',
  					json: true
  				};
  			}

  			editor = CodeMirror.fromTextArea( this.find( 'textarea' ), {
  				mode: mode,
  				theme: this.get( 'theme' ) || 'neo',
  				lineWrapping: this.get( 'wrap' ),
  				readOnly: this.get( 'readonly' )
  			});
  			doc = editor.getDoc();

  			editor.on( 'change', function () {
  				if ( updating ) {
  					return;
  				}

  				updating = true;
  				component.set( 'value', editor.getValue() );
  				updating = false;
  			});

  			editor.on( 'keydown', function ( editor, event ) {
  				var name = CodeMirror.keyNames[ event.which ];

  				return;

  				if ( name ) {
  					component.fire( name.toLowerCase(), {
  						component: component,
  						shift: event.shiftKey,
  						original: event
  					});
  				}
  			});

  			this.observe( 'value', function ( value ) {
  				if ( updating ) {
  					return;
  				}

  				updating = true;
  				editor.setValue( value || '' );
  				updating = false;
  			});

  			this.on( 'teardown', function () {
  				editor.toTextArea();
  			});
  		},

  		isolated: true
  	};

  if ( typeof __import0____component.exports === "object" ) {
  	for ( __import0______prop__ in __import0____component.exports ) {
  		if ( __import0____component.exports.hasOwnProperty(__import0______prop__) ) {
  			__import0______options__[__import0______prop__] = __import0____component.exports[__import0______prop__];
  		}
  	}
  }__import0______export__ = Ractive.extend( __import0______options__ );
  var __import0__ = __import0______export__;

  var __import1__ = { sample:"// example from http://jsmodules.io\nvar asap;\nvar isNode = typeof process !== \"undefined\" &&\n             {}.toString.call(process) === \"[object process]\";\n\nif (isNode) {\n  asap = process.nextTick;\n} else if (typeof setImmediate !== \"undefined\") {\n  asap = setImmediate;\n} else {\n  asap = setTimeout;\n}\n\nexport default asap;\n",
    samples:[ { code:"// example from http://jsmodules.io\nvar asap;\nvar isNode = typeof process !== \"undefined\" &&\n\t\t\t{}.toString.call(process) === \"[object process]\";\n\nif (isNode) {\n  asap = process.nextTick;\n} else if (typeof setImmediate !== \"undefined\") {\n  asap = setImmediate;\n} else {\n  asap = setTimeout;\n}\n\nexport default asap;\n",
        name:"Default export\n" },
      { code:"// example from http://jsmodules.io\nimport asap from \"asap\";\n\nasap(function() {\n  console.log(\"hello async world!\");\n});\n",
        name:"Default import\n" },
      { code:"// example from http://jsmodules.io\nvar asap;\nvar isNode = typeof process !== \"undefined\" &&\n             {}.toString.call(process) === \"[object process]\";\n\nif (isNode) {\n  asap = process.nextTick;\n} else if (typeof setImmediate !== \"undefined\") {\n  asap = setImmediate;\n} else {\n  asap = setTimeout;\n}\n\nexport default asap;\nexport var later = isNode ? process.setImmediate : asap;\n",
        name:"Named exports\n" },
      { code:"// example from http://jsmodules.io\nimport { later } from \"asap\";\n\nlater(function() {\n  console.log(\"Running after other network events\");\n});\n",
        name:"Named imports\n" },
      { code:"// example from http://jsmodules.io\nimport asap, { later } from \"asap\";\n",
        name:"Mixed imports\n" },
      { code:"// example from http://jsmodules.io\nimport { unlink as rm } from \"fs\";\n\nrm(filename, function(err) { /* check errors */ });\n",
        name:"Renaming imports\n" },
      { code:"// example from http://jsmodules.io\nimport * as fs from \"fs\";\n\nfs.unlink(filename, function(err) { /* check errors */ });\n",
        name:"Batch imports\n" },
      { code:"// example from http://jsmodules.io\n\n// exports this function as \"requestAnimationFrame\"\nexport function requestAnimationFrame() {\n  // cross-browser requestAnimationFrame\n}\n\n// exports document.location as \"location\"\nexport var location = document.location;\n",
        name:"Inline named exports\n" },
      { code:"// example from http://jsmodules.io\nexport { getJSON, postJSON, animate };\n\nfunction getJSON() {\n  // implementation\n}\n\nfunction postJSON() {\n  // implementation\n}\n\nfunction animate() {\n  // implementation\n}\n",
        name:"Grouped exports\n" } ] };

  var __dependencies__ = {
  		'data': __import1__
  };

  function require ( path ) {
  	if ( __dependencies__.hasOwnProperty( path ) ) {
  		return __dependencies__[ path ];
  	}

  	throw new Error( 'Could not find required module "' + path + '"' );
  }

  var app____options__ = {
  	template: {v:3,t:[{p:[3,1,45],t:7,e:"div",a:{"class":"app"},f:[{p:[4,2,64],t:7,e:"div",a:{"class":"left"},f:[{p:[5,3,85],t:7,e:"div",a:{"class":"info"},f:[{p:[6,4,107],t:7,e:"p",f:["Type ES6 module code"]}," ",{p:[8,4,139],t:7,e:"select",a:{value:[{t:2,r:"selected",p:[8,19,154]}]},f:[{p:[9,5,173],t:7,e:"option",a:{disabled:0},f:["Examples from jsmodules.io"]}," ",{t:4,f:[{p:[11,6,253],t:7,e:"option",a:{value:[{t:2,r:".",p:[11,21,268]}]},f:[{t:2,r:"name",p:[11,31,278]}]}],n:52,r:"samples",p:[10,5,230]}]}]}," ",{p:[16,3,332],t:7,e:"div",a:{"class":"codemirror-outer"},f:[{p:[17,4,366],t:7,e:"codemirror",a:{theme:"neo",height:"100%",mode:"javascript",value:[{t:2,r:"input",p:[17,67,429]}]}}]}]}," ",{p:[21,2,461],t:7,e:"div",a:{"class":"right"},f:[{p:[22,3,483],t:7,e:"div",a:{"class":"info"},f:[{p:[23,4,505],t:7,e:"label",f:[{p:[23,11,512],t:7,e:"input",a:{type:"radio",name:[{t:2,r:"method",p:[23,37,538]}],value:"toAmd"}}," AMD"]}," ",{p:[24,4,580],t:7,e:"label",f:[{p:[24,11,587],t:7,e:"input",a:{type:"radio",name:[{t:2,r:"method",p:[24,37,613]}],value:"toCjs"}}," CommonJS"]}," ",{p:[25,4,660],t:7,e:"label",f:[{p:[25,11,667],t:7,e:"input",a:{type:"radio",name:[{t:2,r:"method",p:[25,37,693]}],value:"toUmd"}}," UMD"]}," ",{p:[27,4,736],t:7,e:"label",a:{"class":"strictMode"},f:[{p:[27,30,762],t:7,e:"input",a:{type:"checkbox",checked:[{t:2,r:"strictMode",p:[27,62,794]}],disabled:[{t:2,r:"forceStrictMode",p:[27,88,820]}]}}," ",{p:[27,110,842],t:7,e:"a",a:{target:"_blank",href:"https://github.com/esperantojs/esperanto/wiki/Strict-mode"},f:["strict mode"]}]}]}," ",{p:[30,3,962],t:7,e:"div",a:{"class":"codemirror-outer"},f:[{p:[31,4,996],t:7,e:"codemirror",a:{theme:"neo",height:"100%",mode:"javascript",value:[{t:2,r:"output",p:[31,67,1059]}],readonly:"true"}}]}]}]}]},
  	css:".app{position:relative;width:100%}.info{position:absolute;top:0;left:0;width:100%;height:2em;line-height:1;padding:.5em 1em;border-bottom:1px solid #eee;-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box}.left,.right{position:relative;padding:2em 0 0;-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box}.codemirror-outer{position:relative;width:100%;height:100%;padding:1em;-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box}.left{border-right:1px solid #eee}.right{background-color:#f9f9f9}select{position:absolute;top:.2em;right:1em;float:right;font-size:inherit;font-family:inherit}.strictMode{padding-left:1em}@media (min-width:40em){.app{height:100%}.left,.right{float:left;width:50%;height:100%}}",
  	components:{	codemirror: __import0__}
  },
  app__component={},
  app____prop__,
  app____export__;

  	var samples = require( 'data' ).samples;

  	app__component.exports = {
  		debug: true,

  		oninit: function () {
  			this.observe( 'selected', function ( sample ) {
  				this.set( 'input', sample.code );
  			});
  		},

  		data: {
  			samples: samples,
  			input: samples[0].code,
  			method: 'toAmd',
  			moduleName: 'myModule',
  			strict: false,
  			forceStrictMode: false
  		},

  		computed: {
  			output: function () {
  				var self = this, input, strictMode, output, method, moduleName, defaultOnlyOutput;

  				input = this.get( 'input' );
  				strictMode = this.get( 'strictMode' );
  				method = this.get( 'method' );
  				moduleName = this.get( 'moduleName' );

  				try {
  					// we want to know if strict mode is forced, regardless of whether it's set
  					defaultOnlyOutput = esperanto[ method ]( input, { strict: false, name: moduleName }).code;

  					// it should NOT be forced, as `strict: false` succeeded
  					setTimeout( function () {
  						self.set( 'forceStrictMode', false );
  					}, 1000 );
  				} catch ( err ) {
  					// it SHOULD be forced, as `strict: false` failed
  					setTimeout( function () {
  						self.set({
  							forceStrictMode: true,
  							strictMode: true
  						});
  					});

  					strictMode = true;
  				} finally {
  					if ( !strictMode ) {
  						return defaultOnlyOutput;
  					}

  					return esperanto[ method ]( input, { strict: true, name: moduleName }).code;
  				}
  			}
  		}
  	};

  if ( typeof app__component.exports === "object" ) {
  	for ( app____prop__ in app__component.exports ) {
  		if ( app__component.exports.hasOwnProperty(app____prop__) ) {
  			app____options__[app____prop__] = app__component.exports[app____prop__];
  		}
  	}
  }app____export__ = Ractive.extend( app____options__ );
  var app = app____export__;

  return app;

}));
//# sourceMappingURL=/www/ESPERANTO/esperantojs.github.io/.gobble-build/07-esperantoBundle/1/app.js.map