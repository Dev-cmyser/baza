/** @jsx $mol_jsx */
/** @jsxFrag $mol_jsx_frag */
namespace $ {
	export class $giper_baza_dom extends $giper_baza_pawn {
		
		dom( next?: ( Element | Attr | Text )[] ): ( Element | Attr | Text )[] {
			
			const land = this.land()
			const doms = land.Pawn( $giper_baza_dom )
			const regs = land.Pawn( $giper_baza_atom_text )
			
			const used_ids = new Set< string >
			
			const link_of = ( el: Node | string )=> {
				
				if(!( el instanceof this.$.$mol_dom_context.Element )) return null
				if( !el.id ) return null
				
				const link = $giper_baza_link.check( el.id )
				if( link && !used_ids.has( link.str ) ) {
					used_ids.add( link.str )
					return link
				}
				
				el.id = ''
				return null
				
			}
			
			if( next ) {
				
				const sample = [] as ( Element | Attr | string )[]
				let texts = ''

				function flush() {
					if( !texts.length ) return 
					for( const token of texts.matchAll( $giper_baza_text_tokens ) ) {
						sample.push( token[0] )
					}
					texts = ''
				}

				function collect( node: Element | Attr | Text ) {

					switch( node.nodeType ) {
					
						case( node.ELEMENT_NODE ): {
							if( ( node as Element ).localName === 'span' ) {
								link_of( node )
								for( const kid of [ ... node.childNodes ] ) {
									collect( kid as Element )
								}
							} else {
								flush()
								sample.push( node as Element )
							}
							return
						}

						case( node.ATTRIBUTE_NODE ): {
							if( node.nodeName === 'id' ) return
							if( node.nodeName === 'xmlns' ) return
							sample.push( node as Attr )
							return
						}

						case( node.TEXT_NODE ): {
							texts += node.nodeValue!
							return
						}

					}

				}
				for( const node of next ) collect( node )
				flush()
				
				function attr( el: Element ) {
					let res = {} as Record< string, string >
					for( const a of el.attributes ) {
						if( a.name === 'id' ) continue
						res[ a.name ] = a.value
					}
					return res
				}
				
				function val( el: Attr | Element | string ) {
					return typeof el === 'string'
						? el
						: el.localName === 'span'
							? el.textContent
							: el.localName
				}
				
				function tag( el: Attr | Element | string ) {
					return typeof el === 'string'
						? 'term'
						: el.nodeType === el.ATTRIBUTE_NODE
							? 'solo'
							: el.localName === 'span'
								? 'term'
								: 'vals'
				}
				
				let units = this.units()
				
				$mol_reconcile({
					prev: units,
					from: 0,
					to: units.length,
					next: sample,
					equal: ( next, prev )=> {
						if( typeof next === 'string' ) {
							const p = $mol_schema_string.cast( land.sand_decode( prev ) )
							if( !p ) return false
							return p.startsWith( next ) || next.startsWith( p )
						} else if( next.nodeType === next.ATTRIBUTE_NODE ) {
							return land.sand_decode( prev ) === next.nodeName
						} else {
							return prev.self().str === link_of( next )?.str
						}
					},
					drop: ( prev, lead )=> land.sand_wipe( prev ),
					insert: ( next, lead )=> {
						const sand = land.post(
							lead?.self() ?? $giper_baza_link.hole,
							this.head(),
							link_of( next ),
							val( next ),
							tag( next ),
						)
						if( typeof next !== 'string' && next.nodeType === next.ELEMENT_NODE ) {
							;( next as Element ).id = sand.self().str
						}
						return sand
					},
					update: ( next, prev, lead )=> ( typeof next !== 'string' || next === land.sand_decode( prev ) )
						? prev
						: land.post(
							lead?.self() ?? $giper_baza_link.hole,
							prev.head(),
							prev.self(),
							val( next ),
							tag( next ),
						),
					// replace: ( next, prev, lead )=> {
					// 	land.sand_wipe( prev )
					// 	return land.post(
					// 		lead?.self() ?? $giper_baza_link.hole,
					// 		prev.head(),
					// 		link_of( next ),
					// 		val( next ),
					// 		tag( next ),
					// 	)
					// },
				})

				units = this.units()
				for( let i = 0; i < units.length; ++i ) {
					
					const sam = sample[i]
					if( typeof sam === 'string' ) continue

					if( sam.nodeType === sam.ATTRIBUTE_NODE ) {
						regs.Head( units[i].self() ).val( sam.nodeValue )
					} else if( sam.nodeName !== 'span' ) {
						doms.Head( units[i].self() ).dom([
							... ( sam as Element ).attributes,
							... [ ... ( sam as Element ).childNodes ] as Element[],
						] )
					}
					
				}
				
				return next
				
			} else {
				
				return this.units().flatMap( unit => {

					if( unit.tag() === 'solo' ) return []
					
					const Tag = unit.tag() === 'term'
						? 'span'
						: ( land.sand_decode( unit ) as string ) ?? 'p'
					
					const attrs = unit.tag() === 'vals'
						? Object.fromEntries(
							regs.Head( unit.self() ).units()
							.filter( sand => sand.tag() === 'solo' )
							.map( sand => [ land.sand_decode( sand ), regs.Head( sand.self() ).val() ] )
						)
						: {}
					
					const content = unit.tag() === 'term'
						? $mol_schema_string.cast( land.sand_decode( unit ) )
						: doms.Head( unit.self() ).dom()
					
					return <Tag { ... attrs } id={ unit.self().str } giper_baza_dom_link={ unit.self() } >{ content }</Tag>
					
				} )
				
			}
			
		}
		
		html( next?: string ) {
			
			if( next === undefined ) {
				return $mol_dom_serialize( <>{ this.dom() }</> )
			} else {
				this.dom( [ ... $mol_dom_parse( `<body>${ next }</body>` ).documentElement.childNodes ] as Element[] )
				return next
			}
			
		}

		@ $mol_mem_key
		selection(
			lord: $giper_baza_link,
			next?: readonly[ from: readonly[ self: string, x: number, y: number ], to: readonly[ self: string, x: number, y: number ] ],
		): Exclude< typeof next, undefined >  {

			const base = this.$.$giper_baza_glob.Land( lord ).Data( $giper_baza_flex_user )
			
			if( next ) {
				
				base.caret( next )
				return next
				
			} else {
				
				return base.caret() ?? [ [ this.head().str, 0, 0 ], [ this.head().str, 0, 0 ] ]
				
			}

		}
		
	}
}
