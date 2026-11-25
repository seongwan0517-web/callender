# 디자인 파일(app.css) 다시 만들기

index.html 에 새 Tailwind 클래스를 쓰면 아래를 실행해서 `app.css` 를 다시 만든 뒤 배포하세요.

```
npx -y tailwindcss@3.4.17 -c build/tailwind.config.js -i build/input.css -o app.css --minify
```
