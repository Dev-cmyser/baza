namespace $ {
	$mol_test({

		'мелкий файл режется как обычный'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			const source = new Uint8Array( 2 ** 15 + 1 )
			source[ 2 ** 15 ] = 255

			file.buffer( source )

			$mol_assert_equal( file.chunks().length, 2 )
			$mol_assert_equal( file.grain(), $giper_baza_file_bulk.grain_small )
			$mol_assert_equal( file.buffer(), source )

		},

		'крупный файл режется крупными кусками'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			const size = 4 * 2 ** 20
			const source = new Uint8Array( size )
			for( let i = 0; i < size; i += 997 ) source[ i ] = i & 0xFF

			file.buffer( source )

			const grain = $giper_baza_file_bulk.grain_large

			$mol_assert_equal( file.grain(), grain )
			$mol_assert_equal( file.chunks().length, Math.ceil( size / grain ) )
			$mol_assert_equal( file.buffer(), source )

		},

		'крупных кусков вдвое меньше, чем у обычного файла'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const size = 4 * 2 ** 20

			const source = new Uint8Array( size )

			const plain = land.Data( $giper_baza_file )
			plain.buffer( source )

			const bulk = land.Data( $giper_baza_file_bulk )
			bulk.buffer( source )

			$mol_assert_equal( plain.chunks().length > bulk.chunks().length, true )
			$mol_assert_equal( Math.round( plain.chunks().length / bulk.chunks().length ), 2 )

		},

		'кусок не выходит за предел формата'( $ ) {

			// sand.make кидает Size too large при 2**16 и больше, причём и для
			// внешних балов. Кусок обязан быть строго меньше.
			$mol_assert_equal( $giper_baza_file_bulk.grain_large < 2 ** 16, true )

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			const source = new Uint8Array( $giper_baza_file_bulk.grain_large * 2 )
			source[ source.length - 1 ] = 42

			file.buffer( source )

			$mol_assert_equal( file.chunks().length, 2 )
			$mol_assert_equal( file.buffer(), source )

		},

		'размер известен без чтения содержимого'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			$mol_assert_equal( file.filled(), false )
			$mol_assert_equal( file.size(), 0 )
			$mol_assert_equal( file.grains(), 0 )

			const size = 2 ** 20 + 5
			file.buffer( new Uint8Array( size ) )

			$mol_assert_equal( file.size(), size )
			$mol_assert_equal( file.filled(), true )
			$mol_assert_equal( file.grains(), file.chunks().length )

		},

		'пустой файл не ломает сборку'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			file.buffer( new Uint8Array( 0 ) )

			$mol_assert_equal( file.size(), 0 )
			$mol_assert_equal( file.chunks().length, 0 )
			$mol_assert_equal( file.buffer().byteLength, 0 )

		},

		'содержимое переживает перезапись меньшим'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			const big = new Uint8Array( 2 ** 20 + 3 )
			big[ big.length - 1 ] = 7
			file.buffer( big )

			const small = new Uint8Array( 100 )
			small[ 99 ] = 9
			file.buffer( small )

			$mol_assert_equal( file.size(), 100 )
			$mol_assert_equal( file.grain(), $giper_baza_file_bulk.grain_small )
			$mol_assert_equal( file.buffer(), small )

		},

		async 'blob сохраняет тип и содержимое'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			const source = new Uint8Array( 2 ** 20 + 1 )
			source[ 2 ** 20 ] = 255

			await $mol_wire_async( file ).blob(
				new $mol_blob( [ source ], { type: 'test/test' } )
			)

			$mol_assert_equal( 'test/test', file.blob().type )
			$mol_assert_equal( source, new Uint8Array( await file.blob().arrayBuffer() ) )

		},

		'текст читается обратно'( $ ) {

			const land = $giper_baza_land.make({ $ })
			const file = land.Data( $giper_baza_file_bulk )

			file.str( 'привет' )

			$mol_assert_equal( file.str(), 'привет' )
			$mol_assert_equal( file.type(), 'text/plain' )

		},

	})

}
