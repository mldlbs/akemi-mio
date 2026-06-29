import easyocr, os, json

srcdir = r'D:/work/code/akemi-mio/doc_images'
reader = easyocr.Reader(['ch_sim', 'en'], gpu=False)

files = sorted([f for f in os.listdir(srcdir) if f.startswith('image_') and f.endswith('.png')])

results = {}
for fname in files:
    path = os.path.join(srcdir, fname)
    try:
        result = reader.readtext(path, detail=1, paragraph=True)
        texts = []
        for item in result:
            texts.append(item[1])
        results[fname] = texts
    except Exception as e:
        results[fname] = [f'[ERROR: {e}]']

with open(r'D:/work/code/akemi-mio/doc_images/ocr_results.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

for fname, texts in results.items():
    print(f'\n{"="*60}')
    print(f'=== {fname} ===')
    print(f'{"="*60}')
    for t in texts:
        print(t)
